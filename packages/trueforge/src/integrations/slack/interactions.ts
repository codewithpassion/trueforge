/**
 * Slack interactive callbacks: the `block_actions` payload a button click posts, and the rules
 * that turn one into a decision.
 *
 * Slack sends these `application/x-www-form-urlencoded` with the JSON in a `payload` field, so
 * the signature covers the raw form body and the JSON is only read after it verifies.
 */
import { z } from 'zod';
import type { ConnectedSlackIntegrationManifest } from '../../schemas/integration';
import type { InboundInteraction, InboundSender, InteractionDecision } from '../types';
import { slackInteractionKind } from './appCapabilities';
import { decodeActionValue } from './blocks';
import { slackConversationKey } from './events';

/** Slack's own limit on `response_url` is well under this; the cap bounds what is stored. */
const RESPONSE_URL_MAX = 2048;
/** Only Slack's own hook host is ever posted to, so a forged payload cannot redirect the reply. */
const RESPONSE_URL_HOST = 'hooks.slack.com';

const SlackInteractionUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().optional(),
  name: z.string().optional(),
});

const SlackInteractionActionSchema = z.object({
  action_id: z.string().min(1),
  value: z.string().optional(),
});

const SlackInteractionMessageSchema = z.object({
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
});

/**
 * Only `block_actions` is modelled: the app has no shortcuts, modals or select menus, so any
 * other callback type is something this integration did not ask for.
 */
export const SlackInteractionPayloadSchema = z.object({
  type: z.literal('block_actions'),
  team: z.object({ id: z.string().min(1) }),
  user: SlackInteractionUserSchema,
  channel: z.object({ id: z.string().min(1) }).optional(),
  container: z.object({ message_ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
  message: SlackInteractionMessageSchema.optional(),
  response_url: z.string().max(RESPONSE_URL_MAX),
  actions: z.array(SlackInteractionActionSchema).min(1),
});

export type SlackInteractionPayload = z.infer<typeof SlackInteractionPayloadSchema>;

/** Pulls the JSON document out of the form body Slack posts. */
export function readInteractionPayloadField(body: string): string | undefined {
  const field = new URLSearchParams(body).get('payload');
  return field === null || field.length === 0 ? undefined : field;
}

function senderOf(user: z.infer<typeof SlackInteractionUserSchema>): InboundSender {
  const name = user.username?.trim() ?? '';
  const realName = user.name?.trim() ?? '';
  return { id: user.id, display_name: name || realName || user.id };
}

/**
 * The thread the buttons are in. A message posted into a thread carries the thread on the
 * container; the first message of a thread is its own thread, which is its `message_ts`.
 */
function threadTsOf(payload: SlackInteractionPayload): string | undefined {
  return (
    payload.message?.thread_ts ?? payload.container?.thread_ts ?? payload.message?.ts ?? payload.container?.message_ts
  );
}

export type SlackInteractionDecisionResult =
  | { type: 'interaction'; interaction: InboundInteraction }
  | { type: 'refused_sender'; reason: string; reply_context: string }
  | { type: 'ignore'; reason: string }
  | { type: 'rejected'; reason: string };

/** A reply URL that is not Slack's own is never posted to, whatever the signature said. */
function replyContextOf(responseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(responseUrl);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'https:' && parsed.hostname === RESPONSE_URL_HOST ? responseUrl : undefined;
}

const NOT_AN_APPROVER =
  'You are not on this integration’s approver list, so the decision was not recorded. ' +
  'Ask a workspace admin to add you.';

/**
 * Decides what a verified click becomes. The approver allowlist gates approvals only:
 * answering a question is open to anyone already in the thread, the same way asking is.
 */
export function decideSlackInteraction(input: {
  integrationId: string;
  manifest: ConnectedSlackIntegrationManifest;
  payload: SlackInteractionPayload;
}): SlackInteractionDecisionResult {
  const { integrationId, manifest, payload } = input;
  if (payload.team.id !== manifest.team_id) {
    return { type: 'rejected', reason: 'Slack team does not match this integration' };
  }
  const replyContext = replyContextOf(payload.response_url);
  if (replyContext === undefined) {
    // The signature verified, so this is not an authentication failure; there is simply
    // nowhere safe to answer. Acknowledged and dropped rather than reported as a 401.
    return { type: 'ignore', reason: 'Slack response URL is not a Slack hook URL' };
  }

  const action = payload.actions.find(candidate => slackInteractionKind(candidate.action_id) !== undefined);
  if (action === undefined) {
    return { type: 'ignore', reason: 'No action this integration posted' };
  }
  const kind = slackInteractionKind(action.action_id);
  if (kind === undefined) {
    return { type: 'ignore', reason: 'No action this integration posted' };
  }
  const value = action.value === undefined ? undefined : decodeActionValue(action.value);
  if (value === undefined) {
    return { type: 'ignore', reason: 'Action carries no decodable value' };
  }

  const channelId = payload.channel?.id;
  const threadTs = threadTsOf(payload);
  if (channelId === undefined || threadTs === undefined) {
    return { type: 'ignore', reason: 'Interaction is not attached to a conversation' };
  }

  if (kind !== 'answer' && !manifest.approver_slack_user_ids.includes(payload.user.id)) {
    return { type: 'refused_sender', reason: NOT_AN_APPROVER, reply_context: replyContext };
  }

  const decision: InteractionDecision =
    kind === 'answer'
      ? { type: 'answer', text: value.option ?? '' }
      : { type: 'approval', approved: kind === 'approve' };
  if (decision.type === 'answer' && decision.text.length === 0) {
    return { type: 'ignore', reason: 'Answer button carried no option' };
  }

  return {
    type: 'interaction',
    interaction: {
      integration_id: integrationId,
      conversation_key: slackConversationKey({
        teamId: manifest.team_id,
        channelId,
        threadTs,
      }),
      sender: senderOf(payload.user),
      turn_id: value.turn_id,
      ...(value.tool_call_id === undefined ? {} : { tool_call_id: value.tool_call_id }),
      decision,
      reply_context: replyContext,
    },
  };
}
