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
