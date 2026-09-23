import type {
  ISessionStore,
  SessionHandle,
  TurnRecord,
  TurnState,
  TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { CancellationReason, EventType, TurnNotFoundError } from '@truefoundry/trueforge-core/agent-session';
import { NoResponderError, redisRequest, RequestTimeoutError } from '@truefoundry/trueforge-core/request-reply';
import type { RedisClientType } from 'redis';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { cancelSessionTurn, type CancelTurnDeps } from '../../../src/runtime/nodeTurnExecutor';
import { turnStreamId } from '../../../src/runtime/turnRunner';
import { newId } from '../../../src/utils/id';
import { testNodeTurnExecutor } from './testNodeTurnExecutor';

const EXECUTOR_ID = 'local';

jest.mock('@truefoundry/trueforge-core/request-reply', () => {
  const actual = jest.requireActual<typeof import('@truefoundry/trueforge-core/request-reply')>(
    '@truefoundry/trueforge-core/request-reply',
  );
  return {
    ...actual,
    redisRequest: jest.fn(),
  };
});

const redisRequestMock = jest.mocked(redisRequest);

const SESSION_ID = 's1';
const REDIS = {} as RedisClientType;
const REMOTE_EXECUTOR = 'other1';

function silentLogger(): { warn: jest.Mock } {
  return { warn: jest.fn() };
}

function turnRecord(input: { turnId: string; state: TurnState; activeExecutorId?: string }): TurnRecord {
  return {
    turn_id: input.turnId,
    session_id: SESSION_ID,
    first_turn_id: input.turnId,
    ancestor_ids: [],
    previous_turn_id: null,
    active_executor_id: input.activeExecutorId ?? EXECUTOR_ID,
    state: input.state,
    input: [],
    snapshot: { threads: {}, mcp_servers: null, sandbox_info: null },
    created_at: new Date('2026-07-31T00:00:00.000Z'),
    updated_at: new Date('2026-07-31T00:00:00.000Z'),
    custom: null,
  };
}

function storeReturning(turn: TurnRecord | undefined): Pick<ISessionStore, 'getTurn'> {
  return { getTurn: () => Promise.resolve(turn) };
}

function sessionHandle(): Pick<SessionHandle, 'session_id' | 'freezeTurn'> {
  return {
    session_id: SESSION_ID,
    freezeTurn: jest.fn().mockResolvedValue(undefined),
  };
}

function cancelDeps(input: {
  activeTurns: ActiveTurnRegistry;
  turn: TurnRecord | undefined;
  session?: Pick<SessionHandle, 'session_id' | 'freezeTurn'>;
  redis?: RedisClientType;
  logger?: { warn: jest.Mock };
}): CancelTurnDeps {
  return {
    activeTurns: input.activeTurns,
    session: input.session ?? sessionHandle(),
    sessionStore: storeReturning(input.turn),
    ...(input.redis === undefined ? {} : { redis: input.redis }),
    logger: input.logger ?? silentLogger(),
    executorId: EXECUTOR_ID,
    requestReply: { replyTimeoutMs: 60_000, pollIntervalMs: 500 },
  };
}

/** Registers a live run without consuming its stream, mirroring a turn mid-execution. */
function trackRun(registry: ActiveTurnRegistry, turnId: string): AbortController {
  const abortController = new AbortController();
  registry.track({
    sessionId: SESSION_ID,
    turnId,
    abortController,
    stream: (async function* () {
      await new Promise(() => undefined);
      yield 'never';
    })(),
  });
  return abortController;
}

describe('cancelSessionTurn', () => {
  beforeEach(() => {
    redisRequestMock.mockReset();
  });

  it('aborts a turn running in this process without freezing', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = newId();
    const abortController = trackRun(activeTurns, turnId);
    const session = sessionHandle();

    await cancelSessionTurn(
      cancelDeps({ activeTurns, turn: turnRecord({ turnId: turnId, state: { status: 'running' } }), session }),
      {
        turnId,
      },
    );

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe(CancellationReason.ClientCancelled);
    expect(session.freezeTurn).not.toHaveBeenCalled();
  });

  it('freezes when this executor owns the turn but the run is gone', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = newId();
    const session = sessionHandle();

    await cancelSessionTurn(
      cancelDeps({ activeTurns, turn: turnRecord({ turnId: turnId, state: { status: 'running' } }), session }),
      {
        turnId,
      },
    );

    expect(session.freezeTurn).toHaveBeenCalledWith({
      turn_id: turnId,
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('freezes when the run is not in this process and there is no Redis client', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = 'turn-remote-no-redis';
    const session = sessionHandle();

    await cancelSessionTurn(
      cancelDeps({
        activeTurns,
        turn: turnRecord({ turnId: turnId, state: { status: 'running' }, activeExecutorId: REMOTE_EXECUTOR }),
        session,
      }),
      { turnId },
    );

    expect(session.freezeTurn).toHaveBeenCalledWith({
      turn_id: turnId,
      reason: CancellationReason.ClientCancelled,
    });
  });

  it('does not freeze when the owning peer aborts', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = 'turn-remote-ok';
    const session = sessionHandle();
    redisRequestMock.mockResolvedValue({ status: 200, body: {} });

    await cancelSessionTurn(
      cancelDeps({
        activeTurns,
        turn: turnRecord({ turnId: turnId, state: { status: 'running' }, activeExecutorId: REMOTE_EXECUTOR }),
        session,
        redis: REDIS,
      }),
      { turnId },
    );

    expect(redisRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executorId: REMOTE_EXECUTOR,
      }),
    );
    expect(session.freezeTurn).not.toHaveBeenCalled();
  });

  it('freezes when the owning peer is alive but the turn is not running there', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = 'turn-remote-412';
    const session = sessionHandle();
    redisRequestMock.mockResolvedValue({ status: 412, body: { message: 'Turn is not running on this executor' } });

    await cancelSessionTurn(
      cancelDeps({
        activeTurns,
        turn: turnRecord({ turnId: turnId, state: { status: 'running' }, activeExecutorId: REMOTE_EXECUTOR }),
        session,
        redis: REDIS,
      }),
      { turnId },
    );

    expect(session.freezeTurn).toHaveBeenCalled();
  });

  it('freezes when the owning executor is unreachable', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = 'turn-remote-no-responder';
    const session = sessionHandle();
    const logger = silentLogger();
    redisRequestMock.mockRejectedValue(new NoResponderError(REMOTE_EXECUTOR));

    await expect(
      cancelSessionTurn(
        cancelDeps({
          activeTurns,
          turn: turnRecord({ turnId: turnId, state: { status: 'running' }, activeExecutorId: REMOTE_EXECUTOR }),
          session,
          redis: REDIS,
          logger,
        }),
        { turnId },
      ),
    ).resolves.toBeUndefined();
    expect(session.freezeTurn).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to reach owning executor over Redis; freezing the running turn',
      expect.objectContaining({ sessionId: SESSION_ID, turnId, owner: REMOTE_EXECUTOR }),
    );
  });

  it('freezes when waiting for the owning executor times out', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = 'turn-remote-timeout';
    const session = sessionHandle();
    const logger = silentLogger();
    redisRequestMock.mockRejectedValue(new RequestTimeoutError(60_000));

    await expect(
      cancelSessionTurn(
        cancelDeps({
          activeTurns,
          turn: turnRecord({ turnId: turnId, state: { status: 'running' }, activeExecutorId: REMOTE_EXECUTOR }),
          session,
          redis: REDIS,
          logger,
        }),
        { turnId },
      ),
    ).resolves.toBeUndefined();
    expect(session.freezeTurn).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Timed out waiting for owning executor to cancel; freezing the running turn',
      expect.objectContaining({ sessionId: SESSION_ID, turnId, owner: REMOTE_EXECUTOR }),
    );
  });

  it('freezes when Redis itself cannot be reached', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = 'turn-remote-redis-down';
    const session = sessionHandle();
    const logger = silentLogger();
    redisRequestMock.mockRejectedValue(new Error('Redis connection closed'));

    await expect(
      cancelSessionTurn(
        cancelDeps({
          activeTurns,
          turn: turnRecord({ turnId: turnId, state: { status: 'running' }, activeExecutorId: REMOTE_EXECUTOR }),
          session,
          redis: REDIS,
          logger,
        }),
        { turnId },
      ),
    ).resolves.toBeUndefined();
    expect(session.freezeTurn).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to reach owning executor over Redis; freezing the running turn',
      expect.objectContaining({
        sessionId: SESSION_ID,
        turnId,
        owner: REMOTE_EXECUTOR,
        error: 'Redis connection closed',
      }),
    );
  });

  it('treats a missing turn as a successful cancel', async () => {
    const activeTurns = new ActiveTurnRegistry();
    const turnId = newId();
    const session = sessionHandle();
    session.freezeTurn = jest.fn().mockRejectedValue(new TurnNotFoundError(turnId));

    await expect(
      cancelSessionTurn(
        cancelDeps({ activeTurns, turn: turnRecord({ turnId: turnId, state: { status: 'running' } }), session }),
        {
          turnId,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('NodeTurnExecutor.subscribe', () => {
  it('replays a tool.response an older release wrote with string content as text parts', async () => {
    const eventSubscriptions = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
    const turnId = newId();
    const legacy: TurnStreamingEvent = {
      type: EventType.TOOL_RESPONSE,
      id: 'evt_tool',
      thread_id: 'main',
      tool_call_id: 'c1',
      content: [],
      created_at: '2026-09-24T00:00:00.000Z',
    };
    // Releases before tool content became parts wrote a plain string here.
    Reflect.set(legacy, 'content', 'legacy result');
    await eventSubscriptions.get(turnStreamId('t1', SESSION_ID, turnId)).put(legacy, { streamTTLSeconds: 600 });
    const abort = new AbortController();

    const result = await testNodeTurnExecutor({ eventSubscriptions }).subscribe({
      tenant_id: 't1',
      session_id: SESSION_ID,
      turn_id: turnId,
      after_sequence_number: undefined,
      signal: abort.signal,
    });
    if (!result.ok) throw new Error('expected a subscription');
    const first = await result.events.next();
    abort.abort();
    await result.events.return(undefined);

    expect(first.value).toEqual({
      ...legacy,
      content: [{ type: 'text', text: 'legacy result' }],
      sequence_number: 1,
    });
  });
});
