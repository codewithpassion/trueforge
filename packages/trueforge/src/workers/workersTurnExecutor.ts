import type { CancellationReason, ISessionStore, SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import {
  freezeTurnIgnoringMissing,
  type TurnCancelResult,
  type TurnEventsResult,
  type TurnExecutor,
  type TurnStartInput,
  type TurnStartResult,
} from '../runtime/turnExecutor';
import type { SessionDO } from './SessionDO';
import { decodeTurnEvents } from './turnEventWire';

/** Runs every turn in its session's Durable Object; this Worker only authorizes and relays. */
export class WorkersTurnExecutor implements TurnExecutor {
  readonly #namespace: DurableObjectNamespace<SessionDO>;
  readonly #sessionStore: Pick<ISessionStore, 'getTurn'>;

  constructor(deps: { namespace: DurableObjectNamespace<SessionDO>; sessionStore: Pick<ISessionStore, 'getTurn'> }) {
    this.#namespace = deps.namespace;
    this.#sessionStore = deps.sessionStore;
  }

  async start(input: TurnStartInput): Promise<TurnStartResult> {
    return this.#session(input.session.tenant_id, input.session.session_id).startTurn({
      tenant_id: input.session.tenant_id,
      session_id: input.session.session_id,
      input: input.input,
      previous_turn_id: input.previous_turn_id,
      user_ref: input.userRef,
    });
  }

  async startStreaming(input: TurnStartInput): Promise<TurnEventsResult> {
    const started = await this.start(input);
    if (!started.ok) {
      return started;
    }
    const subscribed = await this.subscribe({
      tenant_id: input.session.tenant_id,
      session_id: input.session.session_id,
      turn_id: started.turn.id,
      after_sequence_number: undefined,
      signal: new AbortController().signal,
    });
    // A turn whose drain ended before writing any event has no stream; the response then carries none.
    if (!subscribed.ok && subscribed.code === 'stream_gone') {
      const empty = new ReadableStream<Uint8Array>({
        start: controller => {
          controller.close();
        },
      });
      return { ok: true, events: decodeTurnEvents({ stream: empty, signal: new AbortController().signal }) };
    }
    return subscribed;
  }

  async subscribe(input: {
    tenant_id: string;
    session_id: string;
    turn_id: string;
    after_sequence_number: number | undefined;
    signal: AbortSignal;
  }): Promise<TurnEventsResult> {
    const subscribed = await this.#session(input.tenant_id, input.session_id).subscribe({
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
    const { cancelled } = await this.#session(session.tenant_id, session.session_id).cancel({
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

  #session(tenantId: string, sessionId: string): DurableObjectStub<SessionDO> {
    return this.#namespace.get(this.#namespace.idFromName(`${tenantId}:${sessionId}`));
  }
}
