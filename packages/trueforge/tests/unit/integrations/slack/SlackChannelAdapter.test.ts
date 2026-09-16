import { SLACK_MESSAGE_MAX_LENGTH } from '../../../../src/integrations/slack/chunk';
import { SlackChannelAdapter } from '../../../../src/integrations/slack/SlackChannelAdapter';
import type { Delivery } from '../../../../src/integrations/types';
import type { SlackIntegrationManifest } from '../../../../src/schemas/integration';
import { signSlackBody, SLACK_TEST_SIGNING_SECRET, slackRequest } from './slackRequest';

const NOW_MS = 1_700_000_000_000;
const BOT = 'U0BOT';
const INTEGRATION_ID = 'int-1';

function manifest(overrides: Partial<SlackIntegrationManifest> = {}): SlackIntegrationManifest {
  return {
    type: 'slack',
    team_id: 'T0TEAM',
    bot_user_id: BOT,
    default_agent_name: 'support-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    auth: { bot_token: 'xoxb-secret-token', signing_secret: SLACK_TEST_SIGNING_SECRET },
    ...overrides,
  };
}

interface Posted {
  channel: string;
  thread_ts: string;
  text: string;
}

function recordingFetch(): { fetchImpl: typeof fetch; posted: Posted[] } {
  const posted: Posted[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  };
  return { fetchImpl, posted };
}

function mentionPayload() {
  return {
    type: 'event_callback',
    team_id: 'T0TEAM',
    event_id: 'Ev001',
    event: {
      type: 'app_mention',
      user: 'U0ALICE',
      text: `<@${BOT}> status please`,
      ts: '1700000000.000100',
      channel: 'C0GENERAL',
      channel_type: 'channel',
    },
  };
}

function receive(request: Request, overrides: Partial<SlackIntegrationManifest> = {}) {
  return new SlackChannelAdapter({ now: () => NOW_MS }).receive({
    request,
    manifest: manifest(overrides),
    integration_id: INTEGRATION_ID,
  });
}

function delivery(content: Delivery['content']): Delivery {
  return {
    id: 'del-1',
    conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100',
    turn_id: 'turn-1',
    content,
  };
}

describe('SlackChannelAdapter.receive', () => {
  it('answers the subscription challenge in plain text', async () => {
    const request = await slackRequest({
      payload: { type: 'url_verification', challenge: 'chal-123', token: 'tok' },
      nowMs: NOW_MS,
    });

    expect(await receive(request)).toEqual({
      type: 'respond',
      status: 200,
      content_type: 'text/plain; charset=utf-8',
      body: 'chal-123',
    });
  });

  it('parses a verified mention into an inbound event bound to this integration', async () => {
    const request = await slackRequest({ payload: mentionPayload(), nowMs: NOW_MS });

    expect(await receive(request)).toMatchObject({
      type: 'event',
      event: {
        integration_id: INTEGRATION_ID,
        conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100',
        text: 'status please',
        event_id: 'Ev001',
      },
    });
  });

  it('refuses a body the signature does not cover', async () => {
    const body = JSON.stringify(mentionPayload());
    const timestamp = String(NOW_MS / 1000);
    const request = new Request('https://trueforge.test/events', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': await signSlackBody({ body: `${body} `, timestamp }),
      },
      body,
    });

    expect(await receive(request)).toMatchObject({ type: 'rejected' });
  });

  it('refuses a request signed with the wrong secret before reading the payload', async () => {
    const request = await slackRequest({ payload: mentionPayload(), nowMs: NOW_MS, signingSecret: 'other-secret' });

    expect(await receive(request)).toEqual({ type: 'rejected', reason: 'Slack signature did not verify' });
  });

  it('refuses a replayed request outside the timestamp window', async () => {
    const request = await slackRequest({ payload: mentionPayload(), nowMs: NOW_MS - 10 * 60 * 1000 });

    expect(await receive(request)).toMatchObject({
      type: 'rejected',
      reason: 'Slack request timestamp is outside the replay window',
    });
  });

  it('ignores a payload shape it does not handle', async () => {
    const request = await slackRequest({ payload: { type: 'app_rate_limited' }, nowMs: NOW_MS });

    expect(await receive(request)).toEqual({ type: 'ignore', reason: 'Unsupported Slack payload' });
  });
});

describe('SlackChannelAdapter.deliver', () => {
  it('posts the answer in its thread as mrkdwn', async () => {
    const { fetchImpl, posted } = recordingFetch();
    const adapter = new SlackChannelAdapter({ fetchImpl });

    expect(
      await adapter.deliver({
        manifest: manifest(),
        delivery: delivery({ type: 'message', text: '**done** — see [docs](https://example.test)' }),
      }),
    ).toEqual({ ok: true });
    expect(posted).toEqual([
      {
        channel: 'C0GENERAL',
        thread_ts: '1700000000.000100',
        text: '*done* — see <https://example.test|docs>',
      },
    ]);
  });

  it('splits a long answer into several in-thread messages', async () => {
    const { fetchImpl, posted } = recordingFetch();
    const adapter = new SlackChannelAdapter({ fetchImpl });
    const long = Array.from({ length: 400 }, (_unused, index) => `line ${String(index)} ${'x'.repeat(20)}`).join('\n');

    expect(
      await adapter.deliver({ manifest: manifest(), delivery: delivery({ type: 'message', text: long }) }),
    ).toEqual({ ok: true });
    expect(posted.length).toBeGreaterThan(1);
    for (const message of posted) {
      expect(message.thread_ts).toBe('1700000000.000100');
      expect(message.text.length).toBeLessThanOrEqual(SLACK_MESSAGE_MAX_LENGTH);
    }
  });

  it('posts a status line for a turn that produced no answer', async () => {
    const { fetchImpl, posted } = recordingFetch();
    const adapter = new SlackChannelAdapter({ fetchImpl });

    await adapter.deliver({
      manifest: manifest(),
      delivery: delivery({ type: 'status', state: 'cancelled', detail: 'The run was cancelled (shutdown).' }),
    });

    expect(posted[0]?.text).toBe('The run was cancelled (shutdown).');
  });

  it('stops at the chunk that failed and reports the reason', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      return call === 1 ? Response.json({ ok: true }) : Response.json({ ok: false, error: 'channel_not_found' });
    };
    const adapter = new SlackChannelAdapter({ fetchImpl });
    const long = 'z'.repeat(SLACK_MESSAGE_MAX_LENGTH * 2 + 10);

    expect(
      await adapter.deliver({ manifest: manifest(), delivery: delivery({ type: 'message', text: long }) }),
    ).toEqual({ ok: false, error: 'Slack rejected the message: channel_not_found' });
    expect(call).toBe(2);
  });

  it('refuses a conversation key that is not a Slack one', async () => {
    const { fetchImpl, posted } = recordingFetch();
    const adapter = new SlackChannelAdapter({ fetchImpl });

    expect(
      await adapter.deliver({
        manifest: manifest(),
        delivery: { ...delivery({ type: 'message', text: 'hi' }), conversation_key: 'teams:x' },
      }),
    ).toMatchObject({ ok: false });
    expect(posted).toEqual([]);
  });
});

describe('SlackChannelAdapter.notice', () => {
  it('posts an out-of-band line into the thread', async () => {
    const { fetchImpl, posted } = recordingFetch();
    const adapter = new SlackChannelAdapter({ fetchImpl });

    expect(
      await adapter.notice({
        manifest: manifest(),
        conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100',
        text: 'Still working on it.',
      }),
    ).toEqual({ ok: true });
    expect(posted).toEqual([{ channel: 'C0GENERAL', thread_ts: '1700000000.000100', text: 'Still working on it.' }]);
  });
});
