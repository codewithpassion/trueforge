import { CancellationReason, EventType } from '@truefoundry/trueforge-core/agent-session';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { D1_MAX_VALUE_BYTES } from '../../src/db/d1/client';
import {
  collectEvents,
  createMockSession,
  d1Persistence,
  migrateDatabase,
  sessionStub,
  TENANT_ID,
  USER_REF,
} from './harness';

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

  it('watchdog alarm settles the other orphans and re-arms when one orphan fails', async () => {
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

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const stores = d1Persistence();
    expect(
      (await stores.sessionStore.getTurn({ session_id: 'watchdog-partial', turn_id: orphanTurnId }))?.state,
    ).toMatchObject({ status: 'cancelled', reason: CancellationReason.Abandoned });
    expect(
      (await stores.sessionStore.getTurn({ session_id: 'watchdog-unsettled', turn_id: unsettledTurnId }))?.state.status,
    ).toBe('running');
    await runInDurableObject(stub, async (_instance, state) => {
      const remaining = state.storage.sql.exec<{ turn_id: string }>('SELECT turn_id FROM started_turns').toArray();
      expect(remaining.map(row => row.turn_id)).toEqual([unsettledTurnId]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
