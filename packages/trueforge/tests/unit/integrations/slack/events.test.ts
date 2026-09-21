import { SLACK_BOT_EVENT_SUBSCRIPTIONS } from '../../../../src/integrations/slack/appCapabilities';
import {
  decideSlackEvent,
  parseSlackConversationKey,
  SlackPayloadSchema,
  stripBotMention,
  type SlackEventCallback,
  type SlackMessageEvent,
} from '../../../../src/integrations/slack/events';
import type { ConnectedSlackIntegrationManifest } from '../../../../src/schemas/integration';

const INTEGRATION_ID = 'int-1';
const BOT = 'U0BOT';

function manifest(overrides: Partial<ConnectedSlackIntegrationManifest> = {}): ConnectedSlackIntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'trueforge',
    team_id: 'T0TEAM',
    bot_user_id: BOT,
    default_agent_name: 'support-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
    ...overrides,
  };
}

function callback(event: Partial<SlackMessageEvent> = {}, teamId = 'T0TEAM'): SlackEventCallback {
  return {
    type: 'event_callback',
    team_id: teamId,
    event_id: 'Ev001',
    event: {
      type: 'app_mention',
      user: 'U0ALICE',
      text: `<@${BOT}> what is the status?`,
      ts: '1700000000.000100',
      channel: 'C0GENERAL',
      channel_type: 'channel',
      ...event,
    },
  };
}

function decide(event: Partial<SlackMessageEvent> = {}, overrides: Partial<ConnectedSlackIntegrationManifest> = {}) {
  return decideSlackEvent({
    integrationId: INTEGRATION_ID,
    manifest: manifest(overrides),
    payload: callback(event),
  });
}

describe('stripBotMention', () => {
  it('removes every mention of the bot and collapses the gap', () => {
    expect(stripBotMention({ text: `<@${BOT}> hello  <@${BOT}> again`, botUserId: BOT })).toBe('hello again');
  });

  it('keeps mentions of other users and line breaks', () => {
    expect(stripBotMention({ text: `<@${BOT}> ping <@U0BOB>\nsecond line`, botUserId: BOT })).toBe(
      'ping <@U0BOB>\nsecond line',
    );
  });
});

describe('parseSlackConversationKey', () => {
  it('round-trips a key the adapter produced', () => {
    expect(parseSlackConversationKey('slack:T0TEAM:C0GENERAL:1700000000.000100')).toEqual({
      team_id: 'T0TEAM',
      channel_id: 'C0GENERAL',
      thread_ts: '1700000000.000100',
    });
  });

  it('refuses a key from another channel or a truncated one', () => {
    expect(parseSlackConversationKey('teams:T:C:1')).toBeUndefined();
    expect(parseSlackConversationKey('slack:T:C')).toBeUndefined();
    expect(parseSlackConversationKey('slack:T::1')).toBeUndefined();
  });
});

describe('decideSlackEvent', () => {
  it('turns a channel mention into an event keyed by the thread it starts', () => {
    const decision = decide();
    expect(decision).toMatchObject({
      type: 'event',
      event: {
        integration_id: INTEGRATION_ID,
        conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100',
        text: 'what is the status?',
        event_id: 'Ev001',
        sender: { id: 'U0ALICE', display_name: 'U0ALICE' },
      },
    });
  });

  it('keys a reply by the thread it belongs to, not by its own timestamp', () => {
    expect(decide({ ts: '1700000000.000900', thread_ts: '1700000000.000100' })).toMatchObject({
      type: 'event',
      event: { conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100' },
    });
  });

  it('uses the profile name when Slack sends one', () => {
    expect(decide({ user_profile: { display_name: '', real_name: 'Alice Ng' } })).toMatchObject({
      type: 'event',
      event: { sender: { id: 'U0ALICE', display_name: 'Alice Ng' } },
    });
  });

  it('rejects a payload from another workspace', () => {
    const decision = decideSlackEvent({
      integrationId: INTEGRATION_ID,
      manifest: manifest(),
      payload: callback({}, 'T0OTHER'),
    });
    expect(decision).toEqual({ type: 'rejected', reason: 'Slack team does not match this integration' });
  });

  it('ignores anything an app posted and the bot talking to itself', () => {
    expect(decide({ bot_id: 'B001' })).toMatchObject({ type: 'ignore' });
    expect(decide({ user: BOT })).toMatchObject({ type: 'ignore' });
    expect(decide({ user: undefined })).toMatchObject({ type: 'ignore' });
  });

  it('ignores edits, deletions and every other message subtype', () => {
    expect(decide({ subtype: 'message_changed' })).toMatchObject({
      type: 'ignore',
      reason: 'Unsupported message subtype: message_changed',
    });
    expect(decide({ subtype: 'message_deleted' })).toMatchObject({ type: 'ignore' });
    expect(decide({ subtype: 'channel_join' })).toMatchObject({ type: 'ignore' });
  });

  it('answers only in channels on the allowlist', () => {
    expect(decide({ channel: 'C0SECRET' })).toMatchObject({
      type: 'ignore',
      reason: 'Channel is not on the allowlist',
    });
    expect(decide({}, { allowed_channel_ids: [] })).toMatchObject({ type: 'ignore' });
  });

  it('ignores an unmentioned channel message', () => {
    expect(decide({ type: 'message', text: 'just chatting' })).toMatchObject({
      type: 'ignore',
      reason: 'Only mentions are answered in channels',
    });
  });

  it('answers a direct message only when the manifest allows it', () => {
    const dm = { type: 'message', channel: 'D0ALICE', channel_type: 'im', text: 'hello there' } as const;
    expect(decide(dm)).toMatchObject({
      type: 'event',
      event: { conversation_key: 'slack:T0TEAM:D0ALICE:1700000000.000100', text: 'hello there' },
    });
    expect(decide(dm, { allow_direct_messages: false })).toMatchObject({ type: 'ignore' });
  });

  it('drops the app_mention copy of a mention inside a direct message', () => {
    // Slack delivers the same words twice with different event ids; only the message copy runs.
    expect(decide({ channel: 'D0ALICE', channel_type: 'im' })).toMatchObject({
      type: 'ignore',
      reason: 'Mention in a direct message is handled as a message event',
    });
  });

  it('ignores a mention with nothing left once the bot name is removed', () => {
    expect(decide({ text: `<@${BOT}>` })).toMatchObject({ type: 'ignore' });
  });

  it('ignores a message that is only files, because nothing reads them yet', () => {
    expect(decide({ text: `<@${BOT}>`, files: [{ url_private: 'https://files.slack.test/a.png' }] })).toEqual({
      type: 'ignore',
      reason: 'Message has no text once the mention is removed',
    });
  });

  it('records the files that came with a message that does have text', () => {
    expect(
      decide({ text: `<@${BOT}> look at this`, files: [{ url_private: 'https://files.slack.test/a.png' }] }),
    ).toMatchObject({
      type: 'event',
      event: { text: 'look at this', attachment_urls: ['https://files.slack.test/a.png'] },
    });
  });

  it('treats a direct message as one even when Slack omits channel_type', () => {
    // `app_mention` is documented without `channel_type`, so the `D` prefix has to carry it.
    expect(decide({ channel: 'D0ALICE' })).toMatchObject({
      type: 'ignore',
      reason: 'Mention in a direct message is handled as a message event',
    });
    expect(decide({ type: 'message', channel: 'D0ALICE', text: 'hello there' })).toMatchObject({
      type: 'event',
      event: { conversation_key: 'slack:T0TEAM:D0ALICE:1700000000.000100' },
    });
  });
});

describe('every subscription the manifest asks for reaches a turn', () => {
  // Adding a subscription without teaching `decideSlackEvent` about it would otherwise be
  // silent: the payload would parse and then fall through to an "ignore".
  const context: Record<
    string,
    { event: Partial<SlackMessageEvent>; manifest: Partial<ConnectedSlackIntegrationManifest> }
  > = {
    app_mention: { event: { type: 'app_mention', channel: 'C0GENERAL', channel_type: 'channel' }, manifest: {} },
    'message.im': { event: { type: 'message', channel: 'D0ALICE', channel_type: 'im' }, manifest: {} },
  };

  it.each(Object.entries(SLACK_BOT_EVENT_SUBSCRIPTIONS))(
    'turns a %s payload (event.type %s) into an inbound event',
    (subscription, payloadType) => {
      const fixture = context[subscription];
      expect(fixture).toBeDefined();
      expect(fixture?.event.type).toBe(payloadType);
      const decision = decideSlackEvent({
        integrationId: INTEGRATION_ID,
        manifest: manifest(fixture?.manifest ?? {}),
        payload: callback(fixture?.event ?? {}),
      });
      expect(decision).toMatchObject({ type: 'event' });
    },
  );

  it('rejects a payload type nothing subscribes to', () => {
    const parsed = SlackPayloadSchema.safeParse({
      type: 'event_callback',
      team_id: 'T0TEAM',
      event_id: 'Ev002',
      event: { type: 'reaction_added', user: 'U0ALICE', ts: '1.1', channel: 'C0GENERAL' },
    });
    expect(parsed.success).toBe(false);
  });

  it('caps the challenge it will echo', () => {
    expect(SlackPayloadSchema.safeParse({ type: 'url_verification', challenge: 'a'.repeat(256) }).success).toBe(true);
    expect(SlackPayloadSchema.safeParse({ type: 'url_verification', challenge: 'a'.repeat(257) }).success).toBe(false);
  });
});
