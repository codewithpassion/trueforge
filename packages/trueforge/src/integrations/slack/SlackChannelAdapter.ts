import {
  connectedSlackManifest,
  IntegrationTypeSchema,
  type ConnectedSlackIntegrationManifest,
  type SlackIntegrationManifest,
} from '../../schemas/integration';
import type { ChannelAdapter, DeliveryContent, DeliveryResult, InboundResult } from '../types';
import { postSlackMessage, type SlackFetch } from './api';
import { chunkForSlack } from './chunk';
import { decideSlackEvent, parseSlackConversationKey, SlackPayloadSchema, type SlackPayload } from './events';
import { toMrkdwn } from './mrkdwn';
import {
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  verifySlackSignature,
  type SlackSignatureCheck,
} from './signature';

function statusLine(content: Extract<DeliveryContent, { type: 'status' }>): string {
  return content.detail;
}

type SlackPayloadParse =
  | { type: 'payload'; payload: SlackPayload }
  | { type: 'result'; result: Extract<InboundResult, { type: 'ignore' | 'rejected' }> };

function parseSlackPayload(body: string): SlackPayloadParse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return { type: 'result', result: { type: 'rejected', reason: `Slack request body is not JSON: ${String(error)}` } };
  }
  const payload = SlackPayloadSchema.safeParse(json);
  if (!payload.success) {
    return { type: 'result', result: { type: 'ignore', reason: 'Unsupported Slack payload' } };
  }
  return { type: 'payload', payload: payload.data };
}

function challengeResponse(challenge: string): InboundResult {
  return { type: 'respond', status: 200, content_type: 'text/plain; charset=utf-8', body: challenge };
}

/**
 * Slack messaging over the Events API and `chat.postMessage`.
 *
 * Inbound requests are authenticated by the Slack signature alone, so nothing is read from the
 * body before it verifies, and the workspace in the payload must be the one the manifest names.
 *
 * The one exception is the request-URL challenge for an integration with no signing secret:
 * Slack sends it while it creates the app from the generated manifest, so the secret it signs
 * with does not exist anywhere yet. That branch answers the challenge and nothing else, and
 * becomes unreachable the moment credentials are saved.
 */
export class SlackChannelAdapter implements ChannelAdapter {
  readonly type = IntegrationTypeSchema.enum.slack;
  readonly #fetch: SlackFetch | undefined;
  readonly #now: () => number;

  constructor(options: { fetchImpl?: SlackFetch; now?: () => number } = {}) {
    this.#fetch = options.fetchImpl;
    this.#now = options.now ?? Date.now;
  }

  async receive(input: {
    request: Request;
    manifest: SlackIntegrationManifest;
    integration_id: string;
  }): Promise<InboundResult> {
    const { request } = input;
    const body = await request.text();
    const connected = connectedSlackManifest(input.manifest);
    if (connected === undefined) {
      return this.#receivePending(body);
    }

    const check: SlackSignatureCheck = await verifySlackSignature({
      body,
      timestamp: request.headers.get(SLACK_TIMESTAMP_HEADER),
      signature: request.headers.get(SLACK_SIGNATURE_HEADER),
      signingSecret: connected.auth.signing_secret,
      nowMs: this.#now(),
    });
    if (!check.valid) {
      return { type: 'rejected', reason: check.reason };
    }

    const payload = parseSlackPayload(body);
    if (payload.type !== 'payload') {
      return payload.result;
    }
    if (payload.payload.type === 'url_verification') {
      return challengeResponse(payload.payload.challenge);
    }
    return decideSlackEvent({
      integrationId: input.integration_id,
      manifest: connected,
      payload: payload.payload,
    });
  }

  /**
   * An integration whose credentials are not saved yet can only answer the request-URL
   * challenge. Everything else is refused: with no signing secret there is nothing to check.
   */
  #receivePending(body: string): InboundResult {
    const payload = parseSlackPayload(body);
    if (payload.type !== 'payload') {
      return payload.result;
    }
    if (payload.payload.type === 'url_verification') {
      return challengeResponse(payload.payload.challenge);
    }
    return {
      type: 'not_connected',
      reason: 'Slack credentials are not saved for this integration yet',
    };
  }

  async deliver(input: {
    manifest: SlackIntegrationManifest;
    delivery: { conversation_key: string; content: DeliveryContent };
    signal?: AbortSignal;
  }): Promise<DeliveryResult> {
    const { content } = input.delivery;
    const text = content.type === 'message' ? toMrkdwn(content.text) : statusLine(content);
    return this.#post({
      manifest: input.manifest,
      conversationKey: input.delivery.conversation_key,
      text,
      signal: input.signal,
    });
  }

  async notice(input: {
    manifest: SlackIntegrationManifest;
    conversation_key: string;
    text: string;
  }): Promise<DeliveryResult> {
    return this.#post({ manifest: input.manifest, conversationKey: input.conversation_key, text: input.text });
  }

  /**
   * Posts the text into its thread, split into messages Slack accepts. A chunk that fails stops
   * the rest: a retry repeats the chunks already posted, which reads better than a gap.
   */
  async #post(input: {
    manifest: SlackIntegrationManifest;
    conversationKey: string;
    text: string;
    signal?: AbortSignal | undefined;
  }): Promise<DeliveryResult> {
    const connected: ConnectedSlackIntegrationManifest | undefined = connectedSlackManifest(input.manifest);
    if (connected === undefined) {
      return { ok: false, error: 'Slack credentials are not saved for this integration yet' };
    }
    const conversation = parseSlackConversationKey(input.conversationKey);
    if (conversation === undefined) {
      return { ok: false, error: `Not a Slack conversation key: ${input.conversationKey}` };
    }
    const chunks = chunkForSlack(input.text);
    if (chunks.length === 0) {
      return { ok: true };
    }
    for (const chunk of chunks) {
      const posted = await postSlackMessage({
        botToken: connected.auth.bot_token,
        channel: conversation.channel_id,
        threadTs: conversation.thread_ts,
        text: chunk,
        signal: input.signal,
        ...(this.#fetch === undefined ? {} : { fetchImpl: this.#fetch }),
      });
      if (!posted.ok) {
        return posted.retryAfterMs === undefined
          ? { ok: false, error: posted.error }
          : { ok: false, error: posted.error, retry_after_ms: posted.retryAfterMs };
      }
    }
    return { ok: true };
  }
}
