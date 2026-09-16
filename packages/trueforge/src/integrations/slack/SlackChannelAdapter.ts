import { IntegrationTypeSchema, type SlackIntegrationManifest } from '../../schemas/integration';
import type { ChannelAdapter, DeliveryContent, DeliveryResult, InboundResult } from '../types';
import { postSlackMessage, type SlackFetch } from './api';
import { chunkForSlack } from './chunk';
import { decideSlackEvent, parseSlackConversationKey, SlackPayloadSchema } from './events';
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

/**
 * Slack messaging over the Events API and `chat.postMessage`.
 *
 * Inbound requests are authenticated by the Slack signature alone, so nothing is read from the
 * body before it verifies, and the workspace in the payload must be the one the manifest names.
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
    const { request, manifest } = input;
    const body = await request.text();
    const check: SlackSignatureCheck = await verifySlackSignature({
      body,
      timestamp: request.headers.get(SLACK_TIMESTAMP_HEADER),
      signature: request.headers.get(SLACK_SIGNATURE_HEADER),
      signingSecret: manifest.auth.signing_secret,
      nowMs: this.#now(),
    });
    if (!check.valid) {
      return { type: 'rejected', reason: check.reason };
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      return { type: 'rejected', reason: `Slack request body is not JSON: ${String(error)}` };
    }
    const payload = SlackPayloadSchema.safeParse(json);
    if (!payload.success) {
      return { type: 'ignore', reason: 'Unsupported Slack payload' };
    }
    if (payload.data.type === 'url_verification') {
      return {
        type: 'respond',
        status: 200,
        content_type: 'text/plain; charset=utf-8',
        body: payload.data.challenge,
      };
    }
    return decideSlackEvent({ integrationId: input.integration_id, manifest, payload: payload.data });
  }

  async deliver(input: {
    manifest: SlackIntegrationManifest;
    delivery: { conversation_key: string; content: DeliveryContent };
  }): Promise<DeliveryResult> {
    const { content } = input.delivery;
    const text = content.type === 'message' ? toMrkdwn(content.text) : statusLine(content);
    return this.#post({ manifest: input.manifest, conversationKey: input.delivery.conversation_key, text });
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
  }): Promise<DeliveryResult> {
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
        botToken: input.manifest.auth.bot_token,
        channel: conversation.channel_id,
        threadTs: conversation.thread_ts,
        text: chunk,
        ...(this.#fetch === undefined ? {} : { fetchImpl: this.#fetch }),
      });
      if (!posted.ok) {
        return posted;
      }
    }
    return { ok: true };
  }
}
