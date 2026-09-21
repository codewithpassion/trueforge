import {
  SLACK_BOT_EVENT_SUBSCRIPTIONS,
  SLACK_BOT_SCOPES,
  SLACK_INTERACTION_ACTIONS,
  slackInteractionKind,
} from '../../../../src/integrations/slack/appCapabilities';
import {
  buildSlackAppManifest,
  slackAppManifestJson,
  slackEventsRequestUrl,
  slackInteractionsRequestUrl,
} from '../../../../src/integrations/slack/appManifest';
import { postIntegrationInteractionsRoute } from '../../../../src/routes/integrationRoutes';
import { SlackBotDisplayNameSchema, slackBotUserDisplayName } from '../../../../src/schemas/integration';

const REQUEST_URL = 'https://trueforge.test/api/v1/integrations/int-1/events';
const INTERACTIONS_URL = 'https://trueforge.test/api/v1/integrations/int-1/interactions';

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
    const manifest = buildSlackAppManifest({
      bot_display_name: 'release-bot',
      request_url: REQUEST_URL,
      interactions_request_url: INTERACTIONS_URL,
    });
    expect(manifest.display_information.name).toBe('release-bot');
    expect(manifest.features.bot_user.display_name).toBe('release-bot');
    expect(manifest.settings.event_subscriptions.request_url).toBe(REQUEST_URL);
  });

  // Literal, not derived from the same constants the builder reads: comparing a constant to
  // itself passed happily while a scope was deleted.
  it('asks Slack for exactly these scopes and these subscriptions', () => {
    const manifest = buildSlackAppManifest({
      bot_display_name: 'release-bot',
      request_url: REQUEST_URL,
      interactions_request_url: INTERACTIONS_URL,
    });
    expect(manifest.oauth_config.scopes.bot).toEqual(['app_mentions:read', 'chat:write', 'im:history']);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['app_mention', 'message.im']);
  });

  it('keeps the canonical list and the manifest in step', () => {
    const manifest = buildSlackAppManifest({
      bot_display_name: 'release-bot',
      request_url: REQUEST_URL,
      interactions_request_url: INTERACTIONS_URL,
    });
    expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(Object.keys(SLACK_BOT_EVENT_SUBSCRIPTIONS));
  });

  it('switches interactivity on and points it at this integration', () => {
    const manifest = buildSlackAppManifest({
      bot_display_name: 'release-bot',
      request_url: REQUEST_URL,
      interactions_request_url: INTERACTIONS_URL,
    });
    expect(manifest.settings.interactivity).toEqual({ is_enabled: true, request_url: INTERACTIONS_URL });
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });
});

describe('slackInteractionsRequestUrl', () => {
  it('joins the interactivity path onto the public base URL', () => {
    expect(slackInteractionsRequestUrl({ public_base_url: 'https://trueforge.test', integration_id: 'int-1' })).toBe(
      INTERACTIONS_URL,
    );
  });

  // The manifest's interactivity block and the route the adapter answers on must be the same
  // path; a generated app pointing anywhere else fails only in a live workspace.
  it('is the path the interactions route is mounted at', () => {
    const url = new URL(
      slackInteractionsRequestUrl({ public_base_url: 'https://trueforge.test', integration_id: 'x' }),
    );
    expect(url.pathname).toBe(
      `/api/v1/integrations/x${postIntegrationInteractionsRoute.path.replace('/{integration_id}', '')}`,
    );
  });
});

// Every action id the block builders mint must be one the parser claims, or a click lands
// on a button nothing answers.
describe('the canonical interaction actions', () => {
  it.each(Object.values(SLACK_INTERACTION_ACTIONS))('is recognised: %p', actionId => {
    expect(slackInteractionKind(actionId)).toBeDefined();
  });

  it('recognises an answer button whichever option index it carries', () => {
    expect(slackInteractionKind(`${SLACK_INTERACTION_ACTIONS.answer}4`)).toBe('answer');
  });

  it('claims nothing it did not mint', () => {
    expect(slackInteractionKind('some_other_app_button')).toBeUndefined();
  });
});

describe('the chosen bot name', () => {
  it.each(['TrueForge Bot', 'release-bot', 'Release Bot 2', 'Über Bot', 'Bøt', 'Straße', 'forge.bot', 'a'.repeat(35)])(
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
    ['---', 'no letter or digit'],
    ['___', 'no letter or digit'],
    ['_-_', 'no letter or digit'],
    ['...', 'no letter or digit'],
    ['日本語', 'no Latin letter or digit'],
  ])('rejects %p (%s)', name => {
    const parsed = SlackBotDisplayNameSchema.safeParse(name);
    expect(parsed.success).toBe(false);
  });

  it.each(['slackbot', 'Slackbot', 'Slack helper', 'my-slack-bot'])('rejects %p, which Slack reserves', name => {
    const parsed = SlackBotDisplayNameSchema.safeParse(name);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('slack');
  });

  it('says a name with nothing to slug must contain a letter or a digit', () => {
    const parsed = SlackBotDisplayNameSchema.safeParse('___');
    expect(JSON.stringify(parsed.error?.issues)).toContain('letter or a digit');
  });

  it.each([
    ['TrueForge Bot', 'trueforge-bot'],
    ['Über Bot', 'uber-bot'],
    ['Bøt', 'bot'],
    ['Straße', 'strasse'],
    ['Æon Œuvre', 'aeon-oeuvre'],
    ['Łukasz', 'lukasz'],
    ['release  --  bot', 'release-bot'],
    ['.forge.', 'forge'],
    ['already-fine', 'already-fine'],
  ])('derives the Slack bot user display name %p → %p', (name, expected) => {
    expect(slackBotUserDisplayName(name)).toBe(expected);
  });

  it('keeps the app name as typed and slugs only the bot user', () => {
    const manifest = buildSlackAppManifest({
      bot_display_name: 'TrueForge Bot',
      request_url: REQUEST_URL,
      interactions_request_url: INTERACTIONS_URL,
    });
    expect(manifest.display_information.name).toBe('TrueForge Bot');
    expect(manifest.features.bot_user.display_name).toBe('trueforge-bot');
  });

  it('escapes anything the builder is handed, so the document stays parseable', () => {
    const json = slackAppManifestJson(
      buildSlackAppManifest({
        bot_display_name: 'bot"\\\n',
        request_url: REQUEST_URL,
        interactions_request_url: INTERACTIONS_URL,
      }),
    );
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({ display_information: { name: 'bot"\\\n' } });
  });
});
