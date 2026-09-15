import { CancellationReason, EventType } from '@truefoundry/trueforge-core/agent-session';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { D1_MAX_VALUE_BYTES } from '../../src/db/d1/client';
import { StreamGoneError } from '../../src/runtime/event-subscription';
import { turnStreamId } from '../../src/runtime/turnRunner';
import {
  collectEvents,
  createMockSession,
  d1Persistence,
  migrateDatabase,
  sessionStub,
  TENANT_ID,
  USER_REF,
} from './harness';
import { GAP_MS } from './mockLlm';

function startRequest(sessionId: string, extraText: string[] = []) {
  return {
    tenant_id: TENANT_ID,
    session_id: sessionId,
    input: ['hi', ...extraText].map(content => ({ type: 'user.message' as const, content })),
    previous_turn_id: undefined,
    user_ref: USER_REF,
  };
}

async function startedTurnId(sessionId: string): Promise<string> {
  const started = await sessionStub(sessionId).startTurn(startRequest(sessionId));
  if (!started.ok) {
    throw new Error(`startTurn failed: ${started.code} ${started.message}`);
  }
  expect(started.turn.state).toEqual({ status: 'running' });
  return started.turn.id;
}

async function subscribeEvents(input: { sessionId: string; turnId: string; afterSequenceNumber: number | undefined }) {
  const subscribed = await sessionStub(input.sessionId).subscribe({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    turn_id: input.turnId,
    after_sequence_number: input.afterSequenceNumber,
  });
  if (!subscribed.ok) {
    throw new Error(`subscribe failed: ${subscribed.code} ${subscribed.message}`);
  }
  return collectEvents(subscribed.stream);
}

function startedTurnRows(stub: ReturnType<typeof sessionStub>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{
        turn_id: string;
        attempts: number;
        first_failed_at: number | null;
      }>('SELECT turn_id, attempts, first_failed_at FROM started_turns')
      .toArray(),
  );
}

/** Reads a slow turn's stream through its one model delta, after which the poll parks; returns the turn id. */
async function readTurnIdThroughModelDelta(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('model.message.delta')) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error('The stream ended before the model delta');
    }
    received += decoder.decode(value, { stream: true });
  }
  const created: unknown = JSON.parse(received.slice(0, received.indexOf('\n')));
  if (
    typeof created !== 'object' ||
    created === null ||
    !('turn_id' in created) ||
    typeof created.turn_id !== 'string'
  ) {
    throw new Error('The stream did not start with turn.created');
  }
  return created.turn_id;
}

/** Console lines a spied logger method wrote about one turn. */
function logLinesAbout(spy: { mock: { calls: unknown[][] } }, turnId: string): unknown[] {
  return spy.mock.calls.map(([line]) => line).filter(line => typeof line === 'string' && line.includes(turnId));
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('SessionDO', () => {
  it('streams a full turn from turn.created to turn.done', async () => {
    const stores = await createMockSession({ sessionId: 'stream-full', scenario: 'text' });
    const turnId = await startedTurnId('stream-full');

    const events = await subscribeEvents({ sessionId: 'stream-full', turnId, afterSequenceNumber: undefined });

    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index + 1));
    expect(events[0]?.type).toBe(EventType.TURN_CREATED);
    const done = events.at(-1);
    expect(done?.type).toBe(EventType.TURN_DONE);
    expect(done !== undefined && 'state' in done ? done.state.status : undefined).toBe('done');
    expect(events.some(event => event.type === 'model.message.delta')).toBe(true);
    const stored = await stores.sessionStore.getTurn({ session_id: 'stream-full', turn_id: turnId });
    expect(stored?.state.status).toBe('done');
  });

  it('starts a turn and returns its stream from the first event in one call', async () => {
    await createMockSession({ sessionId: 'start-streaming', scenario: 'text' });

    const started = await sessionStub('start-streaming').startTurnStreaming(startRequest('start-streaming'));
    if (!started.ok) {
      throw new Error(`startTurnStreaming failed: ${started.code} ${started.message}`);
    }
    const events = await collectEvents(started.stream);

    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index + 1));
    expect(events[0]?.type).toBe(EventType.TURN_CREATED);
    expect(events.at(-1)?.type).toBe(EventType.TURN_DONE);
  });

  it('answers a streaming start whose stream is already gone with 412 instead of an empty stream', async () => {
    await createMockSession({ sessionId: 'start-streaming-gone', scenario: 'text' });
    const stub = sessionStub('start-streaming-gone');
    const started = await stub.startTurn(startRequest('start-streaming-gone'));
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }
    await subscribeEvents({
      sessionId: 'start-streaming-gone',
      turnId: started.turn.id,
      afterSequenceNumber: undefined,
    });

    const result = await runInDurableObject(stub, (instance, state) => {
      // The stream expires between the turn's first event and the streaming read.
      state.storage.sql.exec('DELETE FROM turn_events');
      instance.startTurn = () => Promise.resolve(started);
      return instance.startTurnStreaming(startRequest('start-streaming-gone'));
    });

    expect(result).toEqual({
      ok: false,
      status: 412,
      code: 'stream_gone',
      message: new StreamGoneError(turnStreamId(TENANT_ID, 'start-streaming-gone', started.turn.id)).message,
    });
  });

  it('resumes a subscription strictly after the given sequence number', async () => {
    await createMockSession({ sessionId: 'stream-resume', scenario: 'text' });
    const turnId = await startedTurnId('stream-resume');
    const all = await subscribeEvents({ sessionId: 'stream-resume', turnId, afterSequenceNumber: 0 });

    const resumed = await subscribeEvents({ sessionId: 'stream-resume', turnId, afterSequenceNumber: 2 });

    expect(resumed).toEqual(all.slice(2));
    expect(resumed[0]?.sequence_number).toBe(3);
  });

  it('reports a stream that never existed as gone', async () => {
    await createMockSession({ sessionId: 'stream-gone', scenario: 'text' });

    const subscribed = await sessionStub('stream-gone').subscribe({
      tenant_id: TENANT_ID,
      session_id: 'stream-gone',
      turn_id: 'no-such-turn',
      after_sequence_number: undefined,
    });

    expect(subscribed).toMatchObject({ ok: false, status: 412, code: 'stream_gone' });
  });

  it('answers 404 for a session that does not exist', async () => {
    await expect(sessionStub('missing-session').startTurn(startRequest('missing-session'))).resolves.toMatchObject({
      ok: false,
      status: 404,
      code: 'not_found',
    });
  });

  it('cancels a running turn', async () => {
    await createMockSession({ sessionId: 'cancel-running', scenario: 'slow' });
    const turnId = await startedTurnId('cancel-running');

    const cancelled = await sessionStub('cancel-running').cancel({
      session_id: 'cancel-running',
      turn_id: turnId,
      reason: CancellationReason.ClientCancelled,
    });
    const events = await subscribeEvents({ sessionId: 'cancel-running', turnId, afterSequenceNumber: undefined });

    expect(cancelled).toEqual({ ok: true, cancelled: true });
    const done = events.at(-1);
    expect(done !== undefined && 'state' in done ? done.state : undefined).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('releases the poll when its event stream is cancelled inside the Durable Object', async () => {
    await createMockSession({ sessionId: 'stream-local-cancel', scenario: 'slow' });

    await runInDurableObject(sessionStub('stream-local-cancel'), async instance => {
      const started = await instance.startTurnStreaming(startRequest('stream-local-cancel'));
      if (!started.ok) {
        throw new Error(`startTurnStreaming failed: ${started.code} ${started.message}`);
      }
      const reader = started.stream.getReader();
      const turnId = await readTurnIdThroughModelDelta(reader);
      const request = { tenant_id: TENANT_ID, session_id: 'stream-local-cancel', turn_id: turnId };
      const pendingRead = reader.read();
      await expect.poll(() => instance.waitingPollers(request), { timeout: 10_000 }).toBe(1);

      await reader.cancel();

      expect(await pendingRead).toMatchObject({ done: true });
      expect(instance.waitingPollers(request)).toBe(0);
      instance.cancel({ ...request, reason: CancellationReason.ClientCancelled });
    });
  });

  it('keeps the poll parked when the caller cancels its reader across RPC, until the next event', async () => {
    await createMockSession({ sessionId: 'stream-rpc-cancel', scenario: 'slow' });
    const stub = sessionStub('stream-rpc-cancel');
    const started = await stub.startTurnStreaming(startRequest('stream-rpc-cancel'));
    if (!started.ok) {
      throw new Error(`startTurnStreaming failed: ${started.code} ${started.message}`);
    }
    const reader = started.stream.getReader();
    const turnId = await readTurnIdThroughModelDelta(reader);
    const request = { tenant_id: TENANT_ID, session_id: 'stream-rpc-cancel', turn_id: turnId };
    const waitingPollers = () => runInDurableObject(stub, instance => instance.waitingPollers(request));
    const pendingRead = reader.read();
    await expect.poll(waitingPollers, { timeout: 10_000 }).toBe(1);

    await reader.cancel();

    // Pins current workerd behavior: the pending read rejects, but the cancel never reaches the Durable Object.
    // If workerd starts propagating the cancel, flip this assertion to 0 or delete this test.
    await expect(pendingRead).rejects.toThrow('Stream was cancelled.');
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(await waitingPollers()).toBe(1);
    // Cancelling the turn puts turn.done, the next event, which wakes the parked poll.
    await stub.cancel({ ...request, reason: CancellationReason.ClientCancelled });
    await expect.poll(waitingPollers, { timeout: 10_000 }).toBe(0);
  });

  it('releases the parked poll on the next non-terminal event after the caller cancels across RPC', async () => {
    const sessionId = 'stream-rpc-cancel-delta';
    const stores = await createMockSession({ sessionId, scenario: 'gap' });
    const stub = sessionStub(sessionId);
    const started = await stub.startTurnStreaming(startRequest(sessionId));
    if (!started.ok) {
      throw new Error(`startTurnStreaming failed: ${started.code} ${started.message}`);
    }
    const reader = started.stream.getReader();
    const turnId = await readTurnIdThroughModelDelta(reader);
    const request = { tenant_id: TENANT_ID, session_id: sessionId, turn_id: turnId };
    const waitingPollers = () => runInDurableObject(stub, instance => instance.waitingPollers(request));
    const storedDeltas = () =>
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec(
              'SELECT seq FROM turn_events WHERE stream_id = ? AND data LIKE ?',
              turnStreamId(TENANT_ID, sessionId, turnId),
              `%"type":"model.message.delta"%`,
            )
            .toArray().length,
      );
    const pendingRead = reader.read();
    await expect.poll(waitingPollers, { timeout: 10_000 }).toBe(1);

    await reader.cancel();

    await expect(pendingRead).rejects.toThrow('Stream was cancelled.');
    expect(await storedDeltas()).toBe(1);
    await expect.poll(storedDeltas, { timeout: GAP_MS * 3 }).toBe(2);
    // Time for the woken poll to pull again and park, if the object still encoded for the gone reader.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(await waitingPollers()).toBe(0);
    expect((await stores.sessionStore.getTurn({ session_id: sessionId, turn_id: turnId }))?.state.status).toBe(
      'running',
    );
    await stub.cancel({ ...request, reason: CancellationReason.ClientCancelled });
  });

  it('reports cancelled: false for a turn it does not run', async () => {
    await expect(
      sessionStub('cancel-none').cancel({
        session_id: 'cancel-none',
        turn_id: 'not-running-here',
        reason: CancellationReason.ClientCancelled,
      }),
    ).resolves.toEqual({ ok: true, cancelled: false });
  });

  it('rejects turn input larger than D1 stores per value with 413', async () => {
    await createMockSession({ sessionId: 'input-too-large', scenario: 'text' });

    const started = await sessionStub('input-too-large').startTurn(
      startRequest('input-too-large', ['a'.repeat(D1_MAX_VALUE_BYTES)]),
    );

    expect(started).toMatchObject({ ok: false, status: 413, code: 'turn_input_too_large' });
  });

  it('ends a turn with an error event when a reply is larger than D1 stores per value', async () => {
    const stores = await createMockSession({ sessionId: 'reply-too-large', scenario: 'huge' });
    const turnId = await startedTurnId('reply-too-large');

    const events = await subscribeEvents({ sessionId: 'reply-too-large', turnId, afterSequenceNumber: undefined });

    const done = events.at(-1);
    const state = done !== undefined && 'state' in done ? done.state : undefined;
    expect(state).toMatchObject({ status: 'error' });
    expect(state !== undefined && 'message' in state ? state.message : '').toMatch(/exceeds the 2000000-byte limit/);
    const stored = await stores.sessionStore.getTurn({ session_id: 'reply-too-large', turn_id: turnId });
    expect(stored?.state.status).toBe('error');
  });

  it('watchdog alarm freezes a running turn whose Durable Object instance was lost', async () => {
    const stores = await createMockSession({ sessionId: 'watchdog-orphan', scenario: 'slow' });
    const turnId = await startedTurnId('watchdog-orphan');

    // Drops in-memory state (the running task) but keeps storage, like an eviction mid-turn.
    await abortAllDurableObjects();
    expect((await stores.sessionStore.getTurn({ session_id: 'watchdog-orphan', turn_id: turnId }))?.state.status).toBe(
      'running',
    );

    expect(await runDurableObjectAlarm(sessionStub('watchdog-orphan'))).toBe(true);

    const frozen = await d1Persistence().sessionStore.getTurn({ session_id: 'watchdog-orphan', turn_id: turnId });
    expect(frozen?.state).toMatchObject({ status: 'cancelled', reason: CancellationReason.Abandoned });
  });

  it('watchdog alarm settles the other orphans and drops one whose freeze D1 can never accept', async () => {
    await createMockSession({ sessionId: 'watchdog-partial', scenario: 'slow' });
    await createMockSession({ sessionId: 'watchdog-unsettled', scenario: 'slow' });
    const orphanTurnId = await startedTurnId('watchdog-partial');
    const unsettledTurnId = await startedTurnId('watchdog-unsettled');
    await abortAllDurableObjects();
    const stub = sessionStub('watchdog-partial');
    // A running turn whose tenant id D1 refuses to bind, so settling that orphan throws.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO started_turns (turn_id, tenant_id, session_id) VALUES (?, ?, ?)',
        unsettledTurnId,
        't'.repeat(D1_MAX_VALUE_BYTES + 1),
        'watchdog-unsettled',
      );
    });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(logLinesAbout(errors, unsettledTurnId)).toEqual([
        expect.stringContaining('Watchdog dropped an orphaned turn it can never settle'),
      ]);
    } finally {
      errors.mockRestore();
    }
    const stores = d1Persistence();
    expect(
      (await stores.sessionStore.getTurn({ session_id: 'watchdog-partial', turn_id: orphanTurnId }))?.state,
    ).toMatchObject({ status: 'cancelled', reason: CancellationReason.Abandoned });
    expect(
      (await stores.sessionStore.getTurn({ session_id: 'watchdog-unsettled', turn_id: unsettledTurnId }))?.state.status,
    ).toBe('running');
    expect(await startedTurnRows(stub)).toEqual([]);
  });

  it('watchdog alarm retries a failing orphan, then drops it an hour after its first failure', async () => {
    await createMockSession({ sessionId: 'watchdog-bounded', scenario: 'slow' });
    const turnId = await startedTurnId('watchdog-bounded');
    await abortAllDurableObjects();
    // Not valid JSONB, so reading the turn back fails the same way on every alarm.
    await env.DB.prepare('UPDATE turn SET state = ? WHERE turn_id = ?')
      .bind(new Uint8Array([0xff]), turnId)
      .run();
    const stub = sessionStub('watchdog-bounded');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(await startedTurnRows(stub)).toEqual([
        { turn_id: turnId, attempts: 1, first_failed_at: expect.any(Number) },
      ]);
      expect(logLinesAbout(warnings, turnId)).toHaveLength(1);
      expect(logLinesAbout(errors, turnId)).toEqual([]);
      // Many attempts within the hour still retry: only the time since the first failure decides.
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).not.toBeNull();
        state.storage.sql.exec('UPDATE started_turns SET attempts = 99 WHERE turn_id = ?', turnId);
      });

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(await startedTurnRows(stub)).toEqual([
        { turn_id: turnId, attempts: 100, first_failed_at: expect.any(Number) },
      ]);
      expect(logLinesAbout(errors, turnId)).toEqual([]);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          'UPDATE started_turns SET first_failed_at = ? WHERE turn_id = ?',
          Date.now() - 60 * 60 * 1000 - 1,
          turnId,
        );
      });

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(await startedTurnRows(stub)).toEqual([]);
      expect(logLinesAbout(errors, turnId)).toEqual([
        expect.stringContaining('Watchdog gave up on an orphaned turn after an hour of failures'),
      ]);
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  it('watchdog alarm records a retry for an orphan when it cannot open its D1 stores', async () => {
    const stores = await createMockSession({ sessionId: 'watchdog-no-stores', scenario: 'slow' });
    const turnId = await startedTurnId('watchdog-no-stores');
    await abortAllDurableObjects();
    const stub = sessionStub('watchdog-no-stores');
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runInDurableObject(stub, async (instance, state) => {
        const unavailable = {
          get DB(): never {
            throw new Error('D1 binding unavailable');
          },
        };
        expect(Reflect.set(instance, 'env', unavailable)).toBe(true);

        await instance.alarm();

        expect(await state.storage.getAlarm()).not.toBeNull();
      });

      expect(await startedTurnRows(stub)).toEqual([
        { turn_id: turnId, attempts: 1, first_failed_at: expect.any(Number) },
      ]);
      expect(logLinesAbout(warnings, turnId)).toEqual([expect.stringContaining('D1 binding unavailable')]);
    } finally {
      warnings.mockRestore();
    }
    // A fresh instance has its binding again, and the next alarm settles the orphan.
    await abortAllDurableObjects();
    const freshStub = sessionStub('watchdog-no-stores');

    expect(await runDurableObjectAlarm(freshStub)).toBe(true);

    expect(await startedTurnRows(freshStub)).toEqual([]);
    expect(
      (await stores.sessionStore.getTurn({ session_id: 'watchdog-no-stores', turn_id: turnId }))?.state,
    ).toMatchObject({ status: 'cancelled', reason: CancellationReason.Abandoned });
  });

  it('adds the retry columns to a started_turns table created before them and keeps its rows', async () => {
    await runInDurableObject(sessionStub('watchdog-migration'), (_instance, state) => {
      state.storage.sql.exec('DROP TABLE started_turns');
      state.storage.sql.exec(
        'CREATE TABLE started_turns (turn_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL)',
      );
      state.storage.sql.exec(
        'INSERT INTO started_turns (turn_id, tenant_id, session_id) VALUES (?, ?, ?)',
        'turn-before-migration',
        TENANT_ID,
        'watchdog-migration',
      );
    });
    // The next instance runs the constructor's schema step against the old table.
    await abortAllDurableObjects();

    await runInDurableObject(sessionStub('watchdog-migration'), (_instance, state) => {
      const columns = state.storage.sql.exec<{ name: string }>('PRAGMA table_info(started_turns)').toArray();
      expect(columns.map(column => column.name)).toEqual([
        'turn_id',
        'tenant_id',
        'session_id',
        'attempts',
        'first_failed_at',
      ]);
      expect(state.storage.sql.exec('SELECT * FROM started_turns').toArray()).toEqual([
        {
          turn_id: 'turn-before-migration',
          tenant_id: TENANT_ID,
          session_id: 'watchdog-migration',
          attempts: 0,
          first_failed_at: null,
        },
      ]);
    });
  });
});
