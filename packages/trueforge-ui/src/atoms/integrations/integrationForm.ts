/**
 * Form state for a channel integration and the rules that turn it into a request.
 *
 * Kept apart from the section so the decisions — what is required when, which change the
 * server will refuse — are testable without a DOM.
 */
import type { IntegrationBase, IntegrationNotificationRule, UpdateIntegrationRequest } from '@/server/types.js';

export interface IntegrationFormDraft {
  /** Name the bot takes in the channel; also the name of the app the manifest creates. */
  botDisplayName: string;
  /** Comma or newline separated; an empty list allows no channel. */
  allowedChannels: string;
  allowDirectMessages: boolean;
  /** Comma or newline separated channel user ids; an empty list allows nobody to approve. */
  approverUserIds: string;
  /** Edited as rows, because each one is three fields that only mean anything together. */
  notificationRules: IntegrationNotificationRule[];
}

export const EMPTY_INTEGRATION_FORM: IntegrationFormDraft = {
  botDisplayName: '',
  allowedChannels: '',
  allowDirectMessages: true,
  approverUserIds: '',
  notificationRules: [],
};

/** A blank rule row; the outcome starts at the widest filter so the row is valid as soon as it is filled. */
export function emptyNotificationRule(): IntegrationNotificationRule {
  return { scheduleName: '', channelId: '', outcome: 'any' };
}

/** Slack's cap on the app name the bot takes; the character rules are the server's alone. */
const BOT_NAME_MAX = 35;

export function parseAllowedChannels(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function toIntegrationForm(integration: IntegrationBase): IntegrationFormDraft {
  return {
    botDisplayName: integration.botDisplayName,
    allowedChannels: integration.allowedChannelIds.join(', '),
    allowDirectMessages: integration.allowDirectMessages,
    approverUserIds: integration.approverUserIds.join(', '),
    notificationRules: integration.notificationRules.map(rule => ({ ...rule })),
  };
}

/** Ids a person typed, whatever they separated them with. */
export function parseApproverUserIds(value: string): string[] {
  return parseAllowedChannels(value);
}

/** Rows that are still blank are dropped; a half-filled one is a mistake worth naming. */
export function completedNotificationRules(
  rules: readonly IntegrationNotificationRule[],
): IntegrationNotificationRule[] {
  return rules
    .filter(rule => rule.scheduleName.trim().length > 0 || rule.channelId.trim().length > 0)
    .map(rule => ({ ...rule, scheduleName: rule.scheduleName.trim(), channelId: rule.channelId.trim() }));
}

/**
 * The first problem a person should fix, or undefined. Mirrors what the server enforces, so
 * the form says why instead of surfacing a 400.
 */
export function validateIntegrationForm(form: IntegrationFormDraft): string | undefined {
  const botName = form.botDisplayName.trim();
  if (botName.length === 0) {
    return 'A bot name is required.';
  }
  if (botName.length > BOT_NAME_MAX) {
    return `The bot name may be at most ${String(BOT_NAME_MAX)} characters.`;
  }
  if (parseAllowedChannels(form.allowedChannels).length === 0 && !form.allowDirectMessages) {
    return 'Allow direct messages, or list at least one channel, or the bot can never answer.';
  }
  const halfFilled = completedNotificationRules(form.notificationRules).find(
    rule => rule.scheduleName.length === 0 || rule.channelId.length === 0,
  );
  if (halfFilled !== undefined) {
    return 'Every notification rule needs both a schedule and a channel id.';
  }
  return undefined;
}

/** Both credentials travel together: `auth.test` needs the token, ingress needs the secret. */
export function validateCredentials(input: { botToken: string; signingSecret: string }): string | undefined {
  const given = [input.botToken.trim().length > 0, input.signingSecret.trim().length > 0];
  if (given[0] !== given[1]) {
    return 'Paste both the bot token and the signing secret, or neither.';
  }
  return undefined;
}

/**
 * The update to send. Credentials are omitted unless they were typed, which the server reads
 * as "keep what is stored"; a real pair connects a pending integration or rotates a live one.
 */
export function toUpdateIntegrationRequest(input: {
  id: string;
  form: IntegrationFormDraft;
  botToken: string;
  signingSecret: string;
}): UpdateIntegrationRequest {
  const botToken = input.botToken.trim();
  const signingSecret = input.signingSecret.trim();
  const base = {
    id: input.id,
    botDisplayName: input.form.botDisplayName.trim(),
    allowedChannelIds: parseAllowedChannels(input.form.allowedChannels),
    allowDirectMessages: input.form.allowDirectMessages,
    approverUserIds: parseApproverUserIds(input.form.approverUserIds),
    notificationRules: completedNotificationRules(input.form.notificationRules),
  };
  if (botToken.length === 0 || signingSecret.length === 0) {
    return base;
  }
  return { ...base, auth: { botToken, signingSecret } };
}
