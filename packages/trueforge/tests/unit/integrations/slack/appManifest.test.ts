import { SLACK_BOT_EVENT_SUBSCRIPTIONS, SLACK_BOT_SCOPES } from '../../../../src/integrations/slack/appCapabilities';
import {
  buildSlackAppManifest,
  slackAppManifestJson,
  slackEventsRequestUrl,
} from '../../../../src/integrations/slack/appManifest';
import { SlackBotDisplayNameSchema } from '../../../../src/schemas/integration';

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

  it('asks for exactly the scopes and subscriptions the adapter uses', () => {
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

describe('the bot name is safe to paste', () => {
  it.each(['release bot', 'Release-Bot', 'bot"name', 'bot\\name', '', 'a'.repeat(36)])(
    'rejects %p at the schema boundary',
    name => {
      expect(SlackBotDisplayNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it.each(['release-bot', 'forge.bot', 'bot_1', 'a'.repeat(35)])('accepts %p', name => {
    expect(SlackBotDisplayNameSchema.safeParse(name).success).toBe(true);
  });

  it('escapes anything the builder is handed, so the document stays parseable', () => {
    const json = slackAppManifestJson(
      buildSlackAppManifest({ bot_display_name: 'bot"\\\n', request_url: REQUEST_URL }),
    );
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({ display_information: { name: 'bot"\\\n' } });
  });
});
