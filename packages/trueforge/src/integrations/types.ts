/**
 * Ports between the integrations layer and a channel. Channel code reaches turns and
 * sessions only through these shapes, never through the session or turn stores.
 */
import type { TerminalTurnState } from '@truefoundry/trueforge-core/agent-session';
import type { IntegrationManifest, IntegrationType } from '../schemas/integration';

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
  | { type: 'rejected'; reason: string };

/** What the channel should post for a finished turn. */
export type DeliveryContent =
  | { type: 'message'; text: string }
  /** The turn did not produce an answer; the channel posts a short status line instead. */
  | { type: 'status'; state: TerminalTurnState['status']; detail: string };

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

export interface ChannelAdapter<TManifest extends IntegrationManifest = IntegrationManifest> {
  readonly type: IntegrationType;
  /** Verifies authenticity and returns the parsed event, a direct reply, or an ignore. Must finish well under 3 s. */
  receive(input: { request: Request; manifest: TManifest; integration_id: string }): Promise<InboundResult>;
  /** Posts one message; idempotent per delivery id. `signal` is the caller's deadline, if it has one. */
  deliver(input: { manifest: TManifest; delivery: Delivery; signal?: AbortSignal }): Promise<DeliveryResult>;
  /**
   * Posts a line the outbox does not owe, such as telling a conversation that its previous
   * message is still running. Best-effort: nothing retries it.
   */
  notice(input: { manifest: TManifest; conversation_key: string; text: string }): Promise<DeliveryResult>;
}
