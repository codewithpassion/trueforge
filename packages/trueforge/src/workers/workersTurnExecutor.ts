import type { CancellationReason, ISessionStore, SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import {
  freezeTurnIgnoringMissing,
  type TurnCancelResult,
  type TurnEventsResult,
  type TurnExecutor,
  type TurnStartInput,
  type TurnStartResult,
  type TurnStreamingStartInput,
} from '../runtime/turnExecutor';
import type { SessionDO, StartTurnRequest } from './SessionDO';
import { decodeTurnEvents } from './turnEventWire';
import { turnInputTooLarge } from './turnInputLimit';

/**
 * `input.stores` stays in the Worker: the Durable Object resolves the same D1 stores itself, and
 * TrueFoundry mode, whose stores are bound to the caller, is rejected on Workers.
 */
function startTurnRequest(input: TurnStartInput): StartTurnRequest {
  return {
    tenant_id: input.session.tenant_id,
    session_id: input.session.session_id,
    input: input.input,
    previous_turn_id: input.previous_turn_id,
    user_ref: input.userRef,
  };
}

/** Runs every turn in its session's Durable Object; this Worker only authorizes and relays. */
export class WorkersTurnExecutor implements TurnExecutor {
  readonly #namespace: Pick<DurableObjectNamespace<SessionDO>, 'get' | 'idFromName'>;
  readonly #sessionStore: Pick<ISessionStore, 'getTurn'>;

  constructor(deps: {
    namespace: Pick<DurableObjectNamespace<SessionDO>, 'get' | 'idFromName'>;
    sessionStore: Pick<ISessionStore, 'getTurn'>;
  }) {
    this.#namespace = deps.namespace;
    this.#sessionStore = deps.sessionStore;
  }

  async start(input: TurnStartInput): Promise<TurnStartResult> {
    // Also checked before the RPC, whose message size cap would otherwise fail first as a 500.
    const tooLarge = turnInputTooLarge(input.input);
    if (tooLarge !== undefined) {
      return tooLarge;
    }
    return this.#session(input.session).startTurn(startTurnRequest(input));
  }

  async startStreaming(input: TurnStreamingStartInput): Promise<TurnEventsResult> {
    const tooLarge = turnInputTooLarge(input.input);
    if (tooLarge !== undefined) {
      return tooLarge;
    }
    const started = await this.#session(input.session).startTurnStreaming(startTurnRequest(input));
    if (!started.ok) {
      return started;
    }
    return { ok: true, events: decodeTurnEvents({ stream: started.stream, signal: input.signal }) };
  }

  async subscribe(input: {
    tenant_id: string;
    session_id: string;
    turn_id: string;
    after_sequence_number: number | undefined;
    signal: AbortSignal;
  }): Promise<TurnEventsResult> {
    const subscribed = await this.#session(input).subscribe({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      turn_id: input.turn_id,
      after_sequence_number: input.after_sequence_number,
    });
    if (!subscribed.ok) {
      return subscribed;
    }
    return { ok: true, events: decodeTurnEvents({ stream: subscribed.stream, signal: input.signal }) };
  }

  async cancel(input: {
    session: Pick<SessionHandle, 'session_id' | 'tenant_id' | 'freezeTurn'>;
    turn_id: string;
    reason: CancellationReason;
  }): Promise<TurnCancelResult> {
    const { session, turn_id: turnId, reason } = input;
    const turn = await this.#sessionStore.getTurn({ session_id: session.session_id, turn_id: turnId });
    if (turn?.state.status !== 'running') {
      // Missing or already terminal — nothing to cancel.
      return { ok: true };
    }
    const { cancelled } = await this.#session(session).cancel({
      session_id: session.session_id,
      turn_id: turnId,
      reason,
    });
    // Nothing runs the turn (the object was evicted or restarted), so end it in the store.
    if (!cancelled) {
      await freezeTurnIgnoringMissing(session, { turnId, reason });
    }
    return { ok: true };
  }

  #session({ tenant_id: tenantId, session_id: sessionId }: { tenant_id: string; session_id: string }) {
    return this.#namespace.get(this.#namespace.idFromName(`${tenantId}:${sessionId}`));
  }
}
