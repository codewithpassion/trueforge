import { SLACK_BOT_EVENT_SUBSCRIPTIONS, SLACK_BOT_SCOPES } from '../../../../src/integrations/slack/appCapabilities';
import {
  buildSlackAppManifest,
  slackAppManifestJson,
  slackEventsRequestUrl,
} from '../../../../src/integrations/slack/appManifest';
import { SlackBotDisplayNameSchema, slackBotUserDisplayName } from '../../../../src/schemas/integration';

const REQUEST_URL = 'https://trueforge.test/api/v1/integrations/int-1/events';

describe('slackEventsRequestUrl', () => {
  it('joins the ingress path onto the public base URL', () => {
    expect(slackEventsRequestUrl({ public_base_url: 'https://trueforge.test', integration_id: 'int-1' })).toBe(
      REQUEST_URL,
    );
  });

  it('keeps a path prefix from a reverse-proxied deployment', () => {
    expect(slackEventsRequestUrl({ public_base_url: 'https://host.test/forge', integration_id: 'abc' })).toBe(
      'https://host.test/forge/api/v1/integrations/abc/events',
    );
  });
});

describe('buildSlackAppManifest', () => {
  it('names the app and the bot user after the chosen name, and carries the request URL', () => {
    const manifest = buildSlackAppManifest({ bot_display_name: 'release-bot', request_url: REQUEST_URL });
    expect(manifest.display_information.name).toBe('release-bot');
    expect(manifest.features.bot_user.display_name).toBe('release-bot');
    expect(manifest.settings.event_subscriptions.request_url).toBe(REQUEST_URL);
  });

  // Literal, not derived from the same constants the builder reads: comparing a constant to
  // itself passed happily while a scope was deleted.
  it('asks Slack for exactly these scopes and these subscriptions', () => {
    const manifest = buildSlackAppManifest({ bot_display_name: 'release-bot', request_url: REQUEST_URL });
    expect(manifest.oauth_config.scopes.bot).toEqual(['app_mentions:read', 'chat:write', 'im:history']);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['app_mention', 'message.im']);
  });

  it('keeps the canonical list and the manifest in step', () => {
    const manifest = buildSlackAppManifest({ bot_display_name: 'release-bot', request_url: REQUEST_URL });
    expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(Object.keys(SLACK_BOT_EVENT_SUBSCRIPTIONS));
  });

  it('leaves interactivity out until buttons are handled', () => {
    const manifest = buildSlackAppManifest({ bot_display_name: 'release-bot', request_url: REQUEST_URL });
    expect(Object.keys(manifest.settings)).not.toContain('interactivity');
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });
});

describe('the chosen bot name', () => {
  it.each(['TrueForge Bot', 'release-bot', 'Release Bot 2', 'Über Bot', 'forge.bot', 'a'.repeat(35)])(
    'accepts %p',
    name => {
      expect(SlackBotDisplayNameSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['a'.repeat(36), 'over Slack’s 35-character app name limit'],
    ['???', 'nothing left once slugged'],
    ['---', 'nothing left once slugged'],
  ])('rejects %p (%s)', name => {
    expect(SlackBotDisplayNameSchema.safeParse(name).success).toBe(false);
  });

  it.each([
    ['TrueForge Bot', 'trueforge-bot'],
    ['Über Bot', 'uber-bot'],
    ['release  --  bot', 'release-bot'],
    ['.forge.', 'forge'],
    ['already-fine', 'already-fine'],
  ])('derives the Slack bot user display name %p → %p', (name, expected) => {
    expect(slackBotUserDisplayName(name)).toBe(expected);
  });

  it('keeps the app name as typed and slugs only the bot user', () => {
    const manifest = buildSlackAppManifest({ bot_display_name: 'TrueForge Bot', request_url: REQUEST_URL });
    expect(manifest.display_information.name).toBe('TrueForge Bot');
    expect(manifest.features.bot_user.display_name).toBe('trueforge-bot');
  });

  it('escapes anything the builder is handed, so the document stays parseable', () => {
    const json = slackAppManifestJson(
      buildSlackAppManifest({ bot_display_name: 'bot"\\\n', request_url: REQUEST_URL }),
    );
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({ display_information: { name: 'bot"\\\n' } });
  });
});
