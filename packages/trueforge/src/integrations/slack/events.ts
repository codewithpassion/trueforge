/**
 * Slack Events API payloads and the rules that decide whether one becomes a turn.
 * Only the fields the adapter reads are modelled; Slack adds others freely.
 */
import { z } from 'zod';
import type { ConnectedSlackIntegrationManifest } from '../../schemas/integration';
import type { InboundEvent, InboundSender } from '../types';
import { SLACK_BOT_EVENT_SUBSCRIPTIONS } from './appCapabilities';

/** Slack sends this once when the request URL is saved, before any event is delivered. */
const SlackUrlVerificationSchema = z.object({
  type: z.literal('url_verification'),
  // Slack's own challenge is ~52 characters; the cap bounds what an unsigned caller can make
  // a pending integration echo back.
  challenge: z.string().max(256),
});

/** Present on some message events; the bot has no `users:read` scope, so it is the only name source. */
const SlackUserProfileSchema = z.object({
  display_name: z.string().optional(),
  real_name: z.string().optional(),
});

const SlackMessageEventSchema = z.object({
  /** Exactly the payload types the subscriptions in the generated app manifest deliver. */
  type: z.enum(SLACK_BOT_EVENT_SUBSCRIPTIONS),
  /** Absent on message subtypes that carry no author, such as `message_deleted`. */
  user: z.string().optional(),
  /** Set on anything an app posted, including this bot's own replies. */
  bot_id: z.string().optional(),
  /** Edits, deletions, joins and file shares all arrive as a subtype. */
  subtype: z.string().optional(),
  text: z.string().optional(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  channel: z.string(),
  channel_type: z.string().optional(),
  user_profile: SlackUserProfileSchema.optional(),
  files: z.array(z.object({ url_private: z.string().optional() })).optional(),
});

const SlackEventCallbackSchema = z.object({
  type: z.literal('event_callback'),
  team_id: z.string(),
  event_id: z.string(),
  event: SlackMessageEventSchema,
});

/** Both arms carry a `type` literal, so the payload is a discriminated union. */
export const SlackPayloadSchema = z.discriminatedUnion('type', [SlackUrlVerificationSchema, SlackEventCallbackSchema]);

export type SlackPayload = z.infer<typeof SlackPayloadSchema>;
export type SlackEventCallback = z.infer<typeof SlackEventCallbackSchema>;
export type SlackMessageEvent = z.infer<typeof SlackMessageEventSchema>;

/** Slack ids never contain `:`, so the key splits back apart unambiguously. */
export function slackConversationKey(input: { teamId: string; channelId: string; threadTs: string }): string {
  return `slack:${input.teamId}:${input.channelId}:${input.threadTs}`;
}

/**
 * Where a notification rule posts: a channel, not a thread. `thread_ts` is the sentinel
 * `channel`, which no Slack timestamp can collide with, and `parseSlackConversationKey` reads
 * it back as "post at the top level".
 */
export const SLACK_CHANNEL_THREAD_SENTINEL = 'channel';

export function slackChannelKey(input: { teamId: string; channelId: string }): string {
  return slackConversationKey({ ...input, threadTs: SLACK_CHANNEL_THREAD_SENTINEL });
}

export interface SlackConversation {
  team_id: string;
  channel_id: string;
  thread_ts: string;
}

export function parseSlackConversationKey(key: string): SlackConversation | undefined {
  const parts = key.split(':');
  const [scheme, teamId, channelId, threadTs] = parts;
  if (parts.length !== 4 || scheme !== 'slack' || !teamId || !channelId || !threadTs) {
    return undefined;
  }
  return { team_id: teamId, channel_id: channelId, thread_ts: threadTs };
}

/** Removes every `<@Uxxxx>` mention of the bot and collapses the whitespace it leaves behind. */
export function stripBotMention(input: { text: string; botUserId: string }): string {
  return input.text
    .replaceAll(new RegExp(`<@${input.botUserId}(\\|[^>]*)?>`, 'g'), ' ')
    .replaceAll(/[^\S\n]+/g, ' ')
    .trim();
}

function senderOf(event: SlackMessageEvent, userId: string): InboundSender {
  const profile = event.user_profile;
  const name = profile?.display_name?.trim() ?? '';
  const realName = profile?.real_name?.trim() ?? '';
  return { id: userId, display_name: name || realName || userId };
}

export type SlackEventDecision =
  { type: 'event'; event: InboundEvent } | { type: 'ignore'; reason: string } | { type: 'rejected'; reason: string };

/**
 * Decides what an `event_callback` becomes: a turn, a silent drop, or a refusal.
 *
 * A mention inside a DM arrives twice, once as `app_mention` and once as `message` with its own
 * event id; only the `message` copy runs, so the pair does not start two turns.
 */
export function decideSlackEvent(input: {
  integrationId: string;
  manifest: ConnectedSlackIntegrationManifest;
  payload: SlackEventCallback;
}): SlackEventDecision {
  const { integrationId, manifest, payload } = input;
  if (payload.team_id !== manifest.team_id) {
    return { type: 'rejected', reason: 'Slack team does not match this integration' };
  }

  const event = payload.event;
  if (event.bot_id !== undefined) {
    return { type: 'ignore', reason: 'Message was posted by an app' };
  }
  if (event.user === undefined || event.user === manifest.bot_user_id) {
    return { type: 'ignore', reason: "Message is the bot's own or has no author" };
  }
  if (event.subtype !== undefined) {
    return { type: 'ignore', reason: `Unsupported message subtype: ${event.subtype}` };
  }

  // `channel_type` is documented on `message` but not on `app_mention`, so the channel id
  // prefix is the fallback: Slack ids a direct-message conversation with a leading `D`.
  const isDirectMessage = event.channel_type === 'im' || event.channel.startsWith('D');
  if (isDirectMessage) {
    if (!manifest.allow_direct_messages) {
      return { type: 'ignore', reason: 'Direct messages are not enabled for this integration' };
    }
    if (event.type === 'app_mention') {
      return { type: 'ignore', reason: 'Mention in a direct message is handled as a message event' };
    }
  } else {
    if (event.type !== 'app_mention') {
      return { type: 'ignore', reason: 'Only mentions are answered in channels' };
    }
    if (!manifest.allowed_channel_ids.includes(event.channel)) {
      return { type: 'ignore', reason: 'Channel is not on the allowlist' };
    }
  }

  const text = stripBotMention({ text: event.text ?? '', botUserId: manifest.bot_user_id });
  // Attachments are recorded but not fetched, so a message that is only files has nothing to run on.
  if (text.length === 0) {
    return { type: 'ignore', reason: 'Message has no text once the mention is removed' };
  }
  const attachmentUrls = (event.files ?? []).flatMap(file =>
    file.url_private === undefined ? [] : [file.url_private],
  );

  return {
    type: 'event',
    event: {
      integration_id: integrationId,
      conversation_key: slackConversationKey({
        teamId: payload.team_id,
        channelId: event.channel,
        // The first message of a thread has no `thread_ts`; its own `ts` is the thread it starts.
        threadTs: event.thread_ts ?? event.ts,
      }),
      sender: senderOf(event, event.user),
      text,
      attachment_urls: attachmentUrls,
      event_id: payload.event_id,
    },
  };
}
