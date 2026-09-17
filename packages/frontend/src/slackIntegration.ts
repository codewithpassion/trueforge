/**
 * Form state for a Slack connection and the rules that turn it into a manifest.
 *
 * Kept apart from the page so the decisions — which secret is sent, which change the server
 * will refuse — are testable without a DOM.
 */
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface SlackIntegrationForm {
  teamId: string;
  botUserId: string;
  defaultAgentName: string;
  /** Comma or newline separated; an empty list allows no channel. */
  allowedChannels: string;
  allowDirectMessages: boolean;
  /** Blank on an edit means "keep the stored token". */
  botToken: string;
  signingSecret: string;
}

export const EMPTY_SLACK_FORM: SlackIntegrationForm = {
  teamId: '',
  botUserId: '',
  defaultAgentName: '',
  allowedChannels: '',
  allowDirectMessages: true,
  botToken: '',
  signingSecret: '',
};

/** Secrets are never prefilled: the stored value comes back redacted and is not re-editable. */
export function toSlackForm(integration: TrueForgeApi.Integration): SlackIntegrationForm {
  const { manifest } = integration;
  return {
    teamId: manifest.teamId,
    botUserId: manifest.botUserId,
    defaultAgentName: manifest.defaultAgentName,
    allowedChannels: manifest.allowedChannelIds.join(', '),
    allowDirectMessages: manifest.allowDirectMessages,
    botToken: '',
    signingSecret: '',
  };
}

export function parseAllowedChannels(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

/**
 * The first problem a human should fix, or undefined. Mirrors what the server enforces, so the
 * form says why instead of surfacing a 400.
 */
export function validateSlackForm(input: {
  form: SlackIntegrationForm;
  existing?: TrueForgeApi.Integration | undefined;
}): string | undefined {
  const { form, existing } = input;
  const required: [string, string][] = [
    ['Workspace (team) id', form.teamId],
    ['Bot user id', form.botUserId],
    ['Agent name', form.defaultAgentName],
  ];
  for (const [label, value] of required) {
    if (value.trim().length === 0) {
      return `${label} is required.`;
    }
  }
  const secretsGiven = form.botToken.trim().length > 0 && form.signingSecret.trim().length > 0;
  if (existing === undefined && !secretsGiven) {
    return 'A bot token and a signing secret are required to connect a workspace.';
  }
  // Carrying the old workspace's credentials to a new one would never authenticate, so the
  // server refuses it; asking here saves the round trip.
  if (existing !== undefined && form.teamId.trim() !== existing.externalAccountId && !secretsGiven) {
    return 'Changing the workspace needs a new bot token and signing secret.';
  }
  if (parseAllowedChannels(form.allowedChannels).length === 0 && !form.allowDirectMessages) {
    return 'Allow direct messages, or list at least one channel, or the bot can never answer.';
  }
  return undefined;
}

/**
 * The manifest to send. A blank secret reuses the redacted stand-in the list returned, which the
 * server reads as "keep what is stored"; a real value rotates it.
 */
export function toSlackManifest(input: {
  form: SlackIntegrationForm;
  existing?: TrueForgeApi.Integration | undefined;
}): TrueForgeApi.IntegrationManifest {
  const { form, existing } = input;
  const keepOr = (typed: string, stored: string | undefined): string => {
    const value = typed.trim();
    if (value.length > 0) {
      return value;
    }
    if (stored === undefined) {
      throw new Error('A bot token and a signing secret are required to connect a workspace.');
    }
    return stored;
  };
  return {
    type: 'slack',
    teamId: form.teamId.trim(),
    botUserId: form.botUserId.trim(),
    defaultAgentName: form.defaultAgentName.trim(),
    allowedChannelIds: parseAllowedChannels(form.allowedChannels),
    allowDirectMessages: form.allowDirectMessages,
    replyMode: 'thread',
    auth: {
      botToken: keepOr(form.botToken, existing?.manifest.auth.botToken),
      signingSecret: keepOr(form.signingSecret, existing?.manifest.auth.signingSecret),
    },
  };
}

/** The request URL to paste into the Slack app's Event Subscriptions. */
export function slackRequestUrl(input: { integrationId: string; origin: string; basePath: string }): string {
  const base = input.basePath.endsWith('/') ? input.basePath.slice(0, -1) : input.basePath;
  return `${input.origin}${base}/api/v1/integrations/${input.integrationId}/events`;
}
