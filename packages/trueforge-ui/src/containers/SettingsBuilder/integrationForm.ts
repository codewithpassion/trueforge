/**
 * Form state for a channel integration and the rules that turn it into a request.
 *
 * Kept apart from the section so the decisions — what is required when, which change the
 * server will refuse — are testable without a DOM.
 */
import type { IntegrationBase, UpdateIntegrationRequest } from '@/server/types.js';

export interface IntegrationFormDraft {
  /** Name the bot takes in the channel; also the name of the app the manifest creates. */
  botDisplayName: string;
  defaultAgentName: string;
  /** Comma or newline separated; an empty list allows no channel. */
  allowedChannels: string;
  allowDirectMessages: boolean;
}

export const EMPTY_INTEGRATION_FORM: IntegrationFormDraft = {
  botDisplayName: '',
  defaultAgentName: '',
  allowedChannels: '',
  allowDirectMessages: true,
};

/** Slack's cap on the app name the bot takes. */
const BOT_NAME_MAX = 35;

/**
 * The bot user's display name Slack will derive from the chosen name. Mirrors the server so
 * the form can refuse a name that would slug away to nothing before sending it.
 */
export function botUserDisplayName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

export function parseAllowedChannels(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function toIntegrationForm(integration: IntegrationBase): IntegrationFormDraft {
  return {
    botDisplayName: integration.botDisplayName,
    defaultAgentName: integration.defaultAgentName,
    allowedChannels: integration.allowedChannelIds.join(', '),
    allowDirectMessages: integration.allowDirectMessages,
  };
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
  if (botUserDisplayName(botName).length === 0) {
    return 'The bot name must contain a letter or a digit.';
  }
  if (form.defaultAgentName.trim().length === 0) {
    return 'An agent name is required.';
  }
  if (parseAllowedChannels(form.allowedChannels).length === 0 && !form.allowDirectMessages) {
    return 'Allow direct messages, or list at least one channel, or the bot can never answer.';
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
    defaultAgentName: input.form.defaultAgentName.trim(),
    allowedChannelIds: parseAllowedChannels(input.form.allowedChannels),
    allowDirectMessages: input.form.allowDirectMessages,
  };
  if (botToken.length === 0 || signingSecret.length === 0) {
    return base;
  }
  return { ...base, auth: { botToken, signingSecret } };
}
