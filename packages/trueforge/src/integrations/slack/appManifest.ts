/**
 * Builds the Slack app manifest a person pastes into Slack to create the app. Slack verifies
 * the request URL while it creates the app, before any credential exists, which is why the
 * integration is created first and lends the manifest its id.
 */
import { SLACK_BOT_EVENT_SUBSCRIPTIONS, SLACK_BOT_SCOPES } from './appCapabilities';

/** Where Slack accepts a pasted manifest. */
export const SLACK_CREATE_APP_URL = 'https://api.slack.com/apps?new_app=1';

interface SlackAppManifestDisplayInformation {
  name: string;
  description: string;
}

interface SlackAppManifestBotUser {
  display_name: string;
  always_online: boolean;
}

interface SlackAppManifestAppHome {
  home_tab_enabled: boolean;
  messages_tab_enabled: boolean;
  messages_tab_read_only_enabled: boolean;
}

interface SlackAppManifestFeatures {
  bot_user: SlackAppManifestBotUser;
  app_home: SlackAppManifestAppHome;
}

interface SlackAppManifestOauthConfig {
  scopes: { bot: string[] };
}

interface SlackAppManifestEventSubscriptions {
  request_url: string;
  bot_events: string[];
}

interface SlackAppManifestSettings {
  event_subscriptions: SlackAppManifestEventSubscriptions;
  org_deploy_enabled: boolean;
  socket_mode_enabled: boolean;
  token_rotation_enabled: boolean;
}

/** Slack's own document shape; only the parts this integration needs are emitted. */
export interface SlackAppManifest {
  display_information: SlackAppManifestDisplayInformation;
  features: SlackAppManifestFeatures;
  oauth_config: SlackAppManifestOauthConfig;
  settings: SlackAppManifestSettings;
}

/** Ingress path for one integration, joined onto the public base URL. */
export function slackEventsRequestUrl(input: { public_base_url: string; integration_id: string }): string {
  return `${input.public_base_url}/api/v1/integrations/${input.integration_id}/events`;
}

/**
 * No `interactivity` block: buttons and approvals are not handled yet, and a request URL
 * Slack verifies for a feature that does not exist would only fail later.
 */
export function buildSlackAppManifest(input: { bot_display_name: string; request_url: string }): SlackAppManifest {
  return {
    display_information: {
      name: input.bot_display_name,
      description: 'Talk to a TrueForge agent from Slack.',
    },
    features: {
      bot_user: { display_name: input.bot_display_name, always_online: false },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: {
        request_url: input.request_url,
        bot_events: Object.keys(SLACK_BOT_EVENT_SUBSCRIPTIONS),
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function slackAppManifestJson(manifest: SlackAppManifest): string {
  return JSON.stringify(manifest, null, 2);
}
