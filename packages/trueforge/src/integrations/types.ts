/**
 * Ports between the integrations layer and a channel. Channel code reaches turns and
 * sessions only through these shapes, never through the session or turn stores.
 */
import type { TerminalTurnState } from '@truefoundry/trueforge-core/agent-session';
import type { IntegrationManifest, IntegrationType } from '../schemas/integration';
import type { PendingQuestion, PendingToolApproval } from './pendingActions';

/** Who sent the inbound message, as the channel names them. */
export interface InboundSender {
  /** Channel-side user id. */
  id: string;
  display_name: string;
}

/** A verified, parsed channel event reduced to what the layer needs. */
export interface InboundEvent {
  integration_id: string;
  /** Stable key for the channel conversation; becomes the session `external_id`. */
  conversation_key: string;
  sender: InboundSender;
  text: string;
  attachment_urls: readonly string[];
  /** Channel-supplied id, unique per integration, used for replay and retry dedupe. */
  event_id: string;
}

/** An adapter answered the request itself, for example a subscription challenge. */
export interface InboundRespond {
  type: 'respond';
  status: 200;
  content_type: string;
  body: string;
}

export type InboundResult =
  | { type: 'event'; event: InboundEvent }
  | InboundRespond
  | { type: 'ignore'; reason: string }
  | { type: 'rejected'; reason: string }
  /** The channel app exists but its credentials have not been saved, so nothing can be verified. */
  | { type: 'not_connected'; reason: string };

/** What the channel should post for a finished turn. */
export type DeliveryContent =
  | { type: 'message'; text: string }
  /** The turn did not produce an answer; the channel posts a short status line instead. */
  | { type: 'status'; state: TerminalTurnState['status']; detail: string }
  /** The turn is held on tool calls a person has to allow or deny. `intro` is the model's own narration, if any. */
  | { type: 'approval_request'; turn_id: string; intro: string; approvals: readonly PendingToolApproval[] }
  /** The turn is held on a question the agent asked. */
  | { type: 'question'; turn_id: string; intro: string; question: PendingQuestion };

/** One outbound message owed to a conversation. */
export interface Delivery {
  /** Outbox row id; adapters use it to make `deliver` idempotent. */
  id: string;
  conversation_key: string;
  turn_id: string;
  content: DeliveryContent;
}

export type DeliveryResult =
  | { ok: true }
  /** `retry_after_ms` is a pause the channel asked for; the outbox waits at least that long. */
  | { ok: false; error: string; retry_after_ms?: number };

/** What a person chose on a message the channel posted for a paused turn. */
export type InteractionDecision =
  | { type: 'approval'; approved: boolean }
  /** Free text or a chosen option; either way it becomes the tool's response. */
  | { type: 'answer'; text: string };

/** A verified click on one of those messages, reduced to what the layer needs. */
export interface InboundInteraction {
  integration_id: string;
  conversation_key: string;
  sender: InboundSender;
  /** The paused turn the message named. The layer still checks the turn is really waiting. */
  turn_id: string;
  /**
   * The call an answer belongs to. An approval decision settles every call the turn holds —
   * core refuses a resume that leaves one unresolved — so it names none.
   */
  tool_call_id?: string;
  decision: InteractionDecision;
  /**
   * Channel-owned handle for answering this click. Opaque to the layer: only the adapter that
   * produced it reads it, and it is never logged, because it can carry a capability URL.
   */
  reply_context: string;
}

export type InboundInteractionResult =
  | { type: 'interaction'; interaction: InboundInteraction }
  /** The sender may not decide this; `reply_context` tells them so without changing anything. */
  | { type: 'refused_sender'; reason: string; reply_context: string }
  | { type: 'ignore'; reason: string }
  | { type: 'rejected'; reason: string }
  | { type: 'not_connected'; reason: string };

/** What the channel says once a click has been dealt with. */
export type InteractionOutcome =
  /** The decision was taken; the message the buttons were on is replaced by this line. */
  | { type: 'recorded'; summary: string }
  /** Nothing changed, and only the person who clicked hears about it. */
  | { type: 'refused'; reason: string };

export interface ChannelAdapter<TManifest extends IntegrationManifest = IntegrationManifest> {
  readonly type: IntegrationType;
  /** Verifies authenticity and returns the parsed event, a direct reply, or an ignore. Must finish well under 3 s. */
  receive(input: { request: Request; manifest: TManifest; integration_id: string }): Promise<InboundResult>;
  /** Verifies a button click the same way `receive` verifies an event. Must finish well under 3 s. */
  receiveInteraction(input: {
    request: Request;
    manifest: TManifest;
    integration_id: string;
  }): Promise<InboundInteractionResult>;
  /** Posts one message; idempotent per delivery id. `signal` is the caller's deadline, if it has one. */
  deliver(input: { manifest: TManifest; delivery: Delivery; signal?: AbortSignal }): Promise<DeliveryResult>;
  /**
   * Posts a line the outbox does not owe, such as telling a conversation that its previous
   * message is still running. Best-effort: nothing retries it.
   */
  notice(input: { manifest: TManifest; conversation_key: string; text: string }): Promise<DeliveryResult>;
  /** Answers a click: replaces the message it was on, or tells the clicker alone. Best-effort. */
  settleInteraction(input: {
    manifest: TManifest;
    reply_context: string;
    outcome: InteractionOutcome;
  }): Promise<DeliveryResult>;
}
