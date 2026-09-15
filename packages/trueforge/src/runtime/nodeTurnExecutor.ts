import {
  CancellationReason,
  type ISessionStore,
  type SessionHandle,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import {
  redisRequest,
  RequestTimeoutError,
  type RouteHandler as RequestReplyRouteHandler,
  type RequestReplyRouter,
} from '@truefoundry/trueforge-core/request-reply';
import { HTTPException } from 'hono/http-exception';
import type { RedisClientType } from 'redis';
import { z } from 'zod';
import type { SandboxIntegration } from '../sandbox/integration';
import type { ActiveTurnRegistry } from './activeTurns';
import { StreamGoneError, type EventSubscriptionRegistry, type SequencedEvent } from './event-subscription';
import { executorFromTurnId, mintPeeredTurnId } from './peeringIds';
import {
  freezeTurnIgnoringMissing,
  turnStartFailure,
  type TurnCancelResult,
  type TurnEventsResult,
  type TurnExecutor,
  type TurnStartInput,
  type TurnStartResult,
} from './turnExecutor';
import {
  beginTurnExecution,
  drainTurnEvents,
  startTurnInProcess,
  toWireTurn,
  turnStreamId,
  type TurnEventDrainInput,
} from './turnRunner';

/** Request-reply path a replica serves to cancel a turn it owns. */
export const SESSIONS_CANCEL_PATH = 'sessions/cancel';

/** Wire body of a peer cancel; validated on receipt (it crosses processes via Redis). */
const CancelPeerBodySchema = z.object({
  session_id: z.string(),
  turn_id: z.string(),
  reason: z.enum(CancellationReason),
});
type CancelPeerBody = z.infer<typeof CancelPeerBodySchema>;

/** Sleep between reply polls and the overall wait for a peer's cancel reply. */
export interface RequestReplyTimings {
  replyTimeoutMs: number;
  pollIntervalMs: number;
}

function cancelTurnOnThisExecutor(
  activeTurns: ActiveTurnRegistry,
  input: { sessionId: string; turnId: string; reason: CancellationReason },
): boolean {
  return activeTurns.cancelIfRunning({
    sessionId: input.sessionId,
    turnId: input.turnId,
    abortReason: input.reason,
  });
}

/**
 * Peer-facing cancel handler: aborts the turn if it runs in this process.
 * 200 = abort fired, 412 = not running here (treated by callers as a no-op).
 */
export function cancelSessionTurnPeerHandler(activeTurns: ActiveTurnRegistry): RequestReplyRouteHandler {
  // Synchronous by nature; the transport expects a Promise and require-await
  // forbids an async fn without awaits.
  return request => {
    const parsed = CancelPeerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return Promise.resolve({ status: 400, body: { message: 'Invalid sessions/cancel payload' } });
    }
    const found = cancelTurnOnThisExecutor(activeTurns, {
      sessionId: parsed.data.session_id,
      turnId: parsed.data.turn_id,
      reason: parsed.data.reason,
    });
    return Promise.resolve(
      found ? { status: 200, body: {} } : { status: 412, body: { message: 'Turn is not running on this executor' } },
    );
  };
}

/** A registry to abort in, a session to freeze, durable state to read, and a way to reach peers. */
export interface CancelTurnDeps {
  activeTurns: ActiveTurnRegistry;
  session: Pick<SessionHandle, 'session_id' | 'freezeTurn'>;
  sessionStore: Pick<ISessionStore, 'getTurn'>;
  redis?: RedisClientType | undefined;
  logger: Pick<Logger, 'warn'>;
  executorId: string;
  requestReply: RequestReplyTimings;
}

/**
 * Cancels the turn wherever it runs: locally or on the owning peer over Redis
 * request-reply. Callers state the motive; default is a plain client cancel.
 *
 * A confirmed abort (this process, or peer HTTP 200) lets TurnHandle persist
 * the terminal state. If abort cannot be confirmed, this replica freezes the
 * turn in the store so the session is not stuck `running`.
 *
 * Redis timeout and Redis/transport failures are not a clean cancellation —
 * the owning replica may still be executing — but the turn is still frozen.
 * Later writes from that replica lose to first-terminal-write-wins.
 */
export async function cancelSessionTurn(
  deps: CancelTurnDeps,
  input: { turnId: string; reason?: CancellationReason },
): Promise<void> {
  const { turnId, reason = CancellationReason.ClientCancelled } = input;
  const sessionId = deps.session.session_id;

  const turn = await deps.sessionStore.getTurn({
    session_id: sessionId,
    turn_id: turnId,
  });
  if (turn?.state.status !== 'running') {
    // Missing or already terminal — nothing to cancel.
    return;
  }

  const owner = executorFromTurnId(turnId);
  // Without a Redis client there is no peer to ask, so an id naming another
  // replica falls through to the local lookup and freezes if the run is gone.
  if (owner !== deps.executorId && deps.redis) {
    try {
      const reply = await redisRequest<CancelPeerBody>({
        redis: deps.redis,
        executorId: owner,
        path: SESSIONS_CANCEL_PATH,
        request: {
          body: { session_id: sessionId, turn_id: turnId, reason },
        },
        options: {
          replyTimeoutMs: deps.requestReply.replyTimeoutMs,
          pollIntervalMs: deps.requestReply.pollIntervalMs,
        },
      });
      if (reply.status === 200) {
        return;
      }
    } catch (error) {
      const fields = {
        sessionId,
        turnId,
        owner,
        ...extractErrorLogFields(error),
      };
      if (error instanceof RequestTimeoutError) {
        deps.logger.warn('Timed out waiting for owning executor to cancel; freezing the running turn', fields);
      } else {
        deps.logger.warn('Failed to reach owning executor over Redis; freezing the running turn', fields);
      }
    }
    await freezeTurnIgnoringMissing(deps.session, { turnId, reason });
    return;
  }

  const aborted = cancelTurnOnThisExecutor(deps.activeTurns, { sessionId, turnId, reason });
  if (!aborted) {
    await freezeTurnIgnoringMissing(deps.session, { turnId, reason });
  }
}

/** Runs the drain detached and hands its sequenced events to one consumer, which may fall behind. */
function sequencedDrain(
  drainInput: TurnEventDrainInput,
): AsyncGenerator<SequencedEvent<TurnStreamingEvent>, void, unknown> {
  const pending: SequencedEvent<TurnStreamingEvent>[] = [];
  // An object, so the flag flipped by the detached drain is re-read after each wait.
  const drain = { finished: false };
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  void drainTurnEvents({
    ...drainInput,
    onEvent: (event, sequenceNumber) => {
      pending.push({ ...event, sequence_number: sequenceNumber });
      notify();
      return Promise.resolve();
    },
  }).finally(() => {
    drain.finished = true;
    notify();
  });
  return (async function* () {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (drain.finished) {
        return;
      }
      await new Promise<void>(resolve => {
        wake = resolve;
      });
    }
  })();
}

export interface NodeTurnExecutorDeps {
  activeTurns: ActiveTurnRegistry;
  eventSubscriptions: EventSubscriptionRegistry<TurnStreamingEvent>;
  sessionStore: Pick<ISessionStore, 'getTurn'>;
  /** Primary Redis client (server-owned); undefined in standalone mode. */
  redis: RedisClientType | undefined;
  /** Request-reply dispatch table served by this replica's executor. */
  requestReplyRouter: RequestReplyRouter;
  sandboxIntegration: SandboxIntegration | undefined;
  logger: Logger;
  /** Peering identity embedded in the turn ids this process mints. */
  executorId: string;
  requestReply: RequestReplyTimings;
}

/** Runs turns in this process; cancels reach the owning replica over Redis request-reply. */
export class NodeTurnExecutor implements TurnExecutor {
  readonly #deps: NodeTurnExecutorDeps;

  constructor(deps: NodeTurnExecutorDeps) {
    this.#deps = deps;
    deps.requestReplyRouter.registerRoute(SESSIONS_CANCEL_PATH, cancelSessionTurnPeerHandler(deps.activeTurns));
  }

  async start(input: TurnStartInput): Promise<TurnStartResult> {
    try {
      const turn = await startTurnInProcess(this.#executionParams(input));
      return { ok: true, turn: toWireTurn(turn.record) };
    } catch (error) {
      const failure = turnStartFailure(error);
      if (failure) {
        return failure;
      }
      throw error;
    }
  }

  async startStreaming(input: TurnStartInput): Promise<TurnEventsResult> {
    try {
      const { drainInput } = await beginTurnExecution(this.#executionParams(input));
      return { ok: true, events: sequencedDrain(drainInput) };
    } catch (error) {
      const failure = turnStartFailure(error);
      if (failure) {
        return failure;
      }
      throw error;
    }
  }

  async subscribe(input: {
    tenant_id: string;
    session_id: string;
    turn_id: string;
    after_sequence_number: number | undefined;
    signal: AbortSignal;
  }): Promise<TurnEventsResult> {
    const turnEventStream = this.#deps.eventSubscriptions.get(
      turnStreamId(input.tenant_id, input.session_id, input.turn_id),
    );
    try {
      await turnEventStream.assertSubscribable();
    } catch (error) {
      if (error instanceof StreamGoneError) {
        return { ok: false, status: 412, code: 'stream_gone', message: error.message };
      }
      throw error;
    }
    return { ok: true, events: turnEventStream.poll(input.after_sequence_number, { signal: input.signal }) };
  }

  async cancel(input: {
    session: Pick<SessionHandle, 'session_id' | 'tenant_id' | 'freezeTurn'>;
    turn_id: string;
    reason: CancellationReason;
  }): Promise<TurnCancelResult> {
    try {
      await cancelSessionTurn(
        {
          activeTurns: this.#deps.activeTurns,
          session: input.session,
          sessionStore: this.#deps.sessionStore,
          redis: this.#deps.redis,
          logger: this.#deps.logger,
          executorId: this.#deps.executorId,
          requestReply: this.#deps.requestReply,
        },
        { turnId: input.turn_id, reason: input.reason },
      );
      return { ok: true };
    } catch (error) {
      // Turn ids outside the peered grammar cannot name an owner.
      if (error instanceof HTTPException && error.status === 400) {
        return { ok: false, status: 400, code: 'bad_request', message: error.message };
      }
      throw error;
    }
  }

  #executionParams(input: TurnStartInput) {
    return {
      session: input.session,
      turn_id: mintPeeredTurnId(this.#deps.executorId),
      input: input.input,
      previous_turn_id: input.previous_turn_id,
      userRef: input.userRef,
      deps: {
        ...input.stores,
        activeTurns: this.#deps.activeTurns,
        eventSubscriptions: this.#deps.eventSubscriptions,
        logger: this.#deps.logger,
        sandboxIntegration: this.#deps.sandboxIntegration,
      },
    };
  }
}
