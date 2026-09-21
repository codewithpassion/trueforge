/**
 * The single list of Slack permissions this adapter needs. The app-manifest generator asks
 * Slack for exactly these, and the event parser accepts exactly what they deliver, so the
 * generated app and the code that serves it cannot drift apart.
 */

/** Bot token scopes, each one backing a call this directory makes. */
export const SLACK_BOT_SCOPES = [
  /** Mentions in channels are what `decideSlackEvent` answers. */
  'app_mentions:read',
  /** Every reply, notice and status line goes out through `chat.postMessage`. */
  'chat:write',
  /** Direct messages to the bot arrive as `message.im`. */
  'im:history',
] as const;

/**
 * Event subscriptions the app asks for, each mapped to the `event.type` Slack puts in the
 * payload. The keys go into the manifest; the values are what the parser accepts.
 */
export const SLACK_BOT_EVENT_SUBSCRIPTIONS = {
  app_mention: 'app_mention',
  'message.im': 'message',
} as const;

/**
 * Block Kit `action_id`s the app puts on its buttons. The block builders mint exactly these
 * and `slackInteractionKind` accepts exactly these, so a button can never arrive unhandled.
 *
 * An answer button repeats once per option, and Slack wants a distinct id per button in a
 * block, so that one is a prefix the option index is appended to.
 */
export const SLACK_INTERACTION_ACTIONS = {
  approve: 'trueforge_tool_approve',
  deny: 'trueforge_tool_deny',
  answer: 'trueforge_question_answer_',
} as const;

export type SlackInteractionKind = keyof typeof SLACK_INTERACTION_ACTIONS;

/** Interactivity is in the generated app because the adapter answers these actions. */
export const SLACK_INTERACTION_ACTION_IDS: readonly string[] = Object.values(SLACK_INTERACTION_ACTIONS);

/** Which of the app's actions an `action_id` is, or undefined when nothing here minted it. */
export function slackInteractionKind(actionId: string): SlackInteractionKind | undefined {
  if (actionId === SLACK_INTERACTION_ACTIONS.approve) {
    return 'approve';
  }
  if (actionId === SLACK_INTERACTION_ACTIONS.deny) {
    return 'deny';
  }
  return actionId.startsWith(SLACK_INTERACTION_ACTIONS.answer) ? 'answer' : undefined;
}
