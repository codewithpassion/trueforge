import { OpenAPIHono } from '@hono/zod-openapi';
import { CancellationReason, EventType, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createTurnsRouter } from '../../src/apis/turns';
import { createAppErrorHandler } from '../../src/app';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import type { RequestContext } from '../../src/auth/identity';
import { D1_MAX_VALUE_BYTES } from '../../src/db/d1/client';
import { StreamGoneError } from '../../src/runtime/event-subscription';
import type { TurnEventsResult, TurnExecutor, TurnStartInput } from '../../src/runtime/turnExecutor';
import { turnStreamId } from '../../src/runtime/turnRunner';
import { createConsoleLogger } from '../../src/workers/logger';
import { WorkersTurnExecutor } from '../../src/workers/workersTurnExecutor';
import {
  collectTurnEvents,
  createMockSession,
  d1Persistence,
  migrateDatabase,
  sessionStub,
  TENANT_ID,
  USER_REF,
} from './harness';

const CALLER: RequestContext = {
  tenant_id: TENANT_ID,
  subject: { id: USER_REF, type: 'user', display_name: USER_REF },
  roles: [],
  user_credential: null,
};

const logger = createConsoleLogger({ level: 'warn', bindings: { component: 'workers-turn-executor-test' } });

function workersTurnExecutor(): WorkersTurnExecutor {
  return new WorkersTurnExecutor({ namespace: env.SESSION_DO, sessionStore: d1Persistence().sessionStore });
}

async function startInput(sessionId: string, content = 'hi'): Promise<TurnStartInput> {
  const stores = d1Persistence();
  const session = await new Sessions({ sessionStore: stores.sessionStore }).get({
    tenant_id: TENANT_ID,
    session_id: sessionId,
  });
  if (session === undefined) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return {
    session,
    input: [{ type: 'user.message', content }],
    previous_turn_id: undefined,
    userRef: USER_REF,
    stores: {
      agentStore: stores.agentStore,
      modelProviderStore: stores.modelProviderStore,
      mcpServerStore: stores.mcpServerStore,
      sandboxProviderStore: stores.sandboxProviderStore,
      skillStore: stores.skillStore,
    },
  };
}

function eventsOf(result: TurnEventsResult) {
  if (!result.ok) {
    throw new Error(`Expected turn events, got ${result.code}: ${result.message}`);
  }
  return result.events;
}

async function startedTurnId(turnExecutor: TurnExecutor, input: TurnStartInput): Promise<string> {
  const started = await turnExecutor.start(input);
  if (!started.ok) {
    throw new Error(`start failed: ${started.code} ${started.message}`);
  }
  return started.turn.id;
}

function subscribeFrom(input: {
  turnExecutor: TurnExecutor;
  sessionId: string;
  turnId: string;
  afterSequenceNumber: number | undefined;
}) {
  return input.turnExecutor.subscribe({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    turn_id: input.turnId,
    after_sequence_number: input.afterSequenceNumber,
    signal: new AbortController().signal,
  });
}

/** The turns routes over D1 and the Workers executor, answering errors as the server app does. */
function turnsApp(turnExecutor: TurnExecutor) {
  const stores = d1Persistence();
  const app = new OpenAPIHono();
  app.onError(createAppErrorHandler({ logger }));
  app.route(
    '/',
    createTurnsRouter({
      sessions: new Sessions({ sessionStore: stores.sessionStore }),
      sessionStore: stores.sessionStore,
      resolveModelProviderStore: () => stores.modelProviderStore,
      resolveMcpServerStore: () => stores.mcpServerStore,
      resolveSkillStore: () => stores.skillStore,
      resolveAgentStore: () => stores.agentStore,
      turnExecutor,
      resolveSandboxProviderStore: () => stores.sandboxProviderStore,
      sandboxIntegration: undefined,
      logger,
      resolveRequestContext: () => CALLER,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );
  return app;
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('WorkersTurnExecutor', () => {
  it('starts a turn, then replays it from a cursor through subscribe', async () => {
    await createMockSession({ sessionId: 'executor-resume', scenario: 'text' });
    const turnExecutor = workersTurnExecutor();
    const turnId = await startedTurnId(turnExecutor, await startInput('executor-resume'));

    const all = await collectTurnEvents(
      eventsOf(
        await subscribeFrom({ turnExecutor, sessionId: 'executor-resume', turnId, afterSequenceNumber: undefined }),
      ),
    );
    const resumed = await collectTurnEvents(
      eventsOf(await subscribeFrom({ turnExecutor, sessionId: 'executor-resume', turnId, afterSequenceNumber: 2 })),
    );

    expect(all.at(-1)?.type).toBe(EventType.TURN_DONE);
    expect(resumed).toEqual(all.slice(2));
    expect(resumed[0]?.sequence_number).toBe(3);
  });

  it('streams a started turn from turn.created to turn.done', async () => {
    const stores = await createMockSession({ sessionId: 'executor-stream', scenario: 'text' });

    const events = await collectTurnEvents(
      eventsOf(
        await workersTurnExecutor().startStreaming({
          ...(await startInput('executor-stream')),
          signal: new AbortController().signal,
        }),
      ),
    );

    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index + 1));
    expect(events[0]?.type).toBe(EventType.TURN_CREATED);
    const done = events.at(-1);
    expect(done !== undefined && 'state' in done ? done.state.status : undefined).toBe('done');
    const turnId = events[0] !== undefined && 'turn_id' in events[0] ? events[0].turn_id : '';
    expect((await stores.sessionStore.getTurn({ session_id: 'executor-stream', turn_id: turnId }))?.state.status).toBe(
      'done',
    );
  });

  it('rejects oversized input with 413 before calling the Durable Object', async () => {
    await createMockSession({ sessionId: 'executor-too-large', scenario: 'text' });
    const unreachable = {
      get: () => {
        throw new Error('The Durable Object must not be called');
      },
      idFromName: () => {
        throw new Error('The Durable Object must not be called');
      },
    };
    const turnExecutor = new WorkersTurnExecutor({
      namespace: unreachable,
      sessionStore: d1Persistence().sessionStore,
    });
    const input = await startInput('executor-too-large', 'a'.repeat(D1_MAX_VALUE_BYTES));
    const tooLarge = { ok: false, status: 413, code: 'turn_input_too_large' };

    await expect(turnExecutor.start(input)).resolves.toMatchObject(tooLarge);
    await expect(
      turnExecutor.startStreaming({ ...input, signal: new AbortController().signal }),
    ).resolves.toMatchObject(tooLarge);
  });

  it('answers subscribe with 412 over HTTP when the turn is in D1 but its stream expired', async () => {
    await createMockSession({ sessionId: 'executor-stream-gone', scenario: 'text' });
    const turnExecutor = workersTurnExecutor();
    const turnId = await startedTurnId(turnExecutor, await startInput('executor-stream-gone'));
    await collectTurnEvents(
      eventsOf(
        await subscribeFrom({
          turnExecutor,
          sessionId: 'executor-stream-gone',
          turnId,
          afterSequenceNumber: undefined,
        }),
      ),
    );
    const stub = sessionStub('executor-stream-gone');
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE turn_events SET expires_at = ?', Date.now() - 1);
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT 1 FROM turn_events').toArray()).toEqual([]);
    });

    const response = await turnsApp(turnExecutor).request(`/executor-stream-gone/turns/${turnId}/subscribe`);

    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({
      error: { message: new StreamGoneError(turnStreamId(TENANT_ID, 'executor-stream-gone', turnId)).message },
    });
  });

  // Last: aborting Durable Objects drops every running instance.
  it('freezes the turn as client-cancelled when its Durable Object no longer runs it', async () => {
    await createMockSession({ sessionId: 'executor-cancel-lost', scenario: 'slow' });
    const turnExecutor = workersTurnExecutor();
    const input = await startInput('executor-cancel-lost');
    const turnId = await startedTurnId(turnExecutor, input);

    await abortAllDurableObjects();
    const cancelled = await turnExecutor.cancel({
      session: input.session,
      turn_id: turnId,
      reason: CancellationReason.ClientCancelled,
    });

    expect(cancelled).toEqual({ ok: true });
    const stored = await d1Persistence().sessionStore.getTurn({ session_id: 'executor-cancel-lost', turn_id: turnId });
    expect(stored?.state).toMatchObject({ status: 'cancelled', reason: CancellationReason.ClientCancelled });
  });
});
