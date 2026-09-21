import { SLACK_INTERACTION_ACTIONS } from '../../../../src/integrations/slack/appCapabilities';
import { encodeActionValue } from '../../../../src/integrations/slack/blocks';
import { SLACK_SIGNATURE_MAX_AGE_MS } from '../../../../src/integrations/slack/signature';
import { SlackChannelAdapter } from '../../../../src/integrations/slack/SlackChannelAdapter';
import type { SlackIntegrationManifest } from '../../../../src/schemas/integration';
import { SLACK_TEST_SIGNING_SECRET, slackInteractionRequest, slackRequest } from './slackRequest';

const NOW_MS = 1_700_000_000_000;
const INTEGRATION_ID = 'int-1';
const APPROVER = 'U0ADMIN';
const TURN_ID = 'turn-1';
const RESPONSE_URL = 'https://hooks.slack.com/actions/T0TEAM/1/abc';

function manifest(overrides: Partial<SlackIntegrationManifest> = {}): SlackIntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'trueforge',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    default_agent_name: 'support-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    approver_slack_user_ids: [APPROVER],
    notification_rules: [],
    auth: { bot_token: 'xoxb-secret-token', signing_secret: SLACK_TEST_SIGNING_SECRET },
    ...overrides,
  };
}

function clickPayload(
  overrides: {
    action_id?: string;
    value?: string;
    user_id?: string;
    team_id?: string;
    response_url?: string;
    omit_channel?: boolean;
    message?: { ts?: string; thread_ts?: string } | undefined;
  } = {},
) {
  return {
    type: 'block_actions',
    team: { id: overrides.team_id ?? 'T0TEAM' },
    user: { id: overrides.user_id ?? APPROVER, username: 'ada' },
    ...(overrides.omit_channel === true ? {} : { channel: { id: 'C0GENERAL' } }),
    container: { message_ts: '1700000000.000900' },
    message:
      overrides.message === undefined ? { ts: '1700000000.000900', thread_ts: '1700000000.000100' } : overrides.message,
    response_url: overrides.response_url ?? RESPONSE_URL,
    actions: [
      {
        action_id: overrides.action_id ?? SLACK_INTERACTION_ACTIONS.approve,
        value: overrides.value ?? encodeActionValue({ turn_id: TURN_ID, tool_call_id: 'call-1' }),
      },
    ],
  };
}

function receiveInteraction(request: Request, overrides: Partial<SlackIntegrationManifest> = {}) {
  return new SlackChannelAdapter({ now: () => NOW_MS }).receiveInteraction({
    request,
    manifest: manifest(overrides),
    integration_id: INTEGRATION_ID,
  });
}

describe('the interactions signature, over the raw form body', () => {
  it('accepts a correctly signed click', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS }),
    );
    expect(received.type).toBe('interaction');
  });

  it('refuses a signature made with another secret', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS, signingSecret: 'other-secret' }),
    );
    expect(received).toEqual({ type: 'rejected', reason: 'Slack signature did not verify' });
  });

  it('refuses a signature that is simply wrong', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS, signature: `v0=${'ab'.repeat(32)}` }),
    );
    expect(received).toEqual({ type: 'rejected', reason: 'Slack signature did not verify' });
  });

  it('refuses a click signed outside the five-minute window', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS - SLACK_SIGNATURE_MAX_AGE_MS - 1_000 }),
    );
    expect(received).toEqual({ type: 'rejected', reason: 'Slack request timestamp is outside the replay window' });
  });

  it('refuses a click with no signature headers at all', async () => {
    const body = new URLSearchParams({ payload: JSON.stringify(clickPayload()) }).toString();
    const received = await receiveInteraction(
      new Request('https://trueforge.test/api/v1/integrations/int-1/interactions', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    expect(received).toEqual({ type: 'rejected', reason: 'Missing Slack signature headers' });
  });

  // Signing the JSON rather than the form body is the mistake a hand-written fixture hides.
  it('refuses a signature computed over the JSON instead of the form body', async () => {
    const signedOverJson = await slackRequest({ payload: clickPayload(), nowMs: NOW_MS });
    const jsonBody = await signedOverJson.text();
    const formBody = new URLSearchParams({ payload: jsonBody }).toString();
    const received = await receiveInteraction(
      new Request('https://trueforge.test/api/v1/integrations/int-1/interactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': signedOverJson.headers.get('x-slack-request-timestamp') ?? '',
          'x-slack-signature': signedOverJson.headers.get('x-slack-signature') ?? '',
        },
        body: formBody,
      }),
    );
    expect(received).toEqual({ type: 'rejected', reason: 'Slack signature did not verify' });
  });

  it('refuses a click from another workspace even when it verifies', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload({ team_id: 'T0OTHER' }), nowMs: NOW_MS }),
    );
    expect(received).toEqual({ type: 'rejected', reason: 'Slack team does not match this integration' });
  });

  it('refuses every click while the integration is still pending', async () => {
    const received = await new SlackChannelAdapter({ now: () => NOW_MS }).receiveInteraction({
      request: await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS }),
      manifest: {
        type: 'slack',
        bot_display_name: 'release-bot',
        default_agent_name: 'support-bot',
        allowed_channel_ids: [],
        allow_direct_messages: true,
        reply_mode: 'thread',
        approver_slack_user_ids: [],
        notification_rules: [],
      },
      integration_id: INTEGRATION_ID,
    });
    expect(received.type).toBe('not_connected');
  });
});

describe('what a verified click becomes', () => {
  it('maps approve onto an approval for that turn and call', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS }),
    );
    expect(received).toMatchObject({
      type: 'interaction',
      interaction: {
        integration_id: INTEGRATION_ID,
        conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100',
        turn_id: TURN_ID,
        tool_call_id: 'call-1',
        decision: { type: 'approval', approved: true },
        sender: { id: APPROVER, display_name: 'ada' },
      },
    });
  });

  it('maps deny onto a refusal for the same call', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({
        payload: clickPayload({ action_id: SLACK_INTERACTION_ACTIONS.deny }),
        nowMs: NOW_MS,
      }),
    );
    expect(received).toMatchObject({ interaction: { decision: { type: 'approval', approved: false } } });
  });

  it('maps an option button onto the answer it carries', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({
        payload: clickPayload({
          action_id: `${SLACK_INTERACTION_ACTIONS.answer}1`,
          value: encodeActionValue({ turn_id: TURN_ID, tool_call_id: 'call-q', option: 'production' }),
          user_id: 'U0ANYONE',
        }),
        nowMs: NOW_MS,
      }),
    );
    expect(received).toMatchObject({
      interaction: { tool_call_id: 'call-q', decision: { type: 'answer', text: 'production' } },
    });
  });

  it('treats the first message of a thread as its own thread', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({
        payload: clickPayload({ message: { ts: '1700000000.000900' } }),
        nowMs: NOW_MS,
      }),
    );
    expect(received).toMatchObject({ interaction: { conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000900' } });
  });

  it('ignores a button this integration did not post', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload({ action_id: 'some_other_app' }), nowMs: NOW_MS }),
    );
    expect(received).toEqual({ type: 'ignore', reason: 'No action this integration posted' });
  });

  it('ignores a value it cannot decode rather than guessing a turn', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload({ value: 'not-json' }), nowMs: NOW_MS }),
    );
    expect(received).toEqual({ type: 'ignore', reason: 'Action carries no decodable value' });
  });

  it('ignores a click with no conversation to answer in', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload({ omit_channel: true }), nowMs: NOW_MS }),
    );
    expect(received).toEqual({ type: 'ignore', reason: 'Interaction is not attached to a conversation' });
  });

  it('ignores a payload type the app never asked for', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: { type: 'view_submission' }, nowMs: NOW_MS }),
    );
    expect(received).toEqual({ type: 'ignore', reason: 'Unsupported Slack interaction payload' });
  });

  it('ignores a body with no payload field', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS }).then(async request => {
        const signed = await request.text();
        return new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: signed.replace('payload=', 'other='),
        });
      }),
    );
    // The signature no longer covers this body, so it is refused before the field is missed.
    expect(received.type).toBe('rejected');
  });

  // The reply URL is a capability: posting to whatever a payload names would be an SSRF.
  it('refuses a reply URL that is not one of Slack’s hooks', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({
        payload: clickPayload({ response_url: 'https://attacker.test/collect' }),
        nowMs: NOW_MS,
      }),
    );
    expect(received).toEqual({ type: 'rejected', reason: 'Slack response URL is not a Slack hook URL' });
  });
});

describe('who may approve', () => {
  it('refuses a user who is not on the allowlist, and changes nothing', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload({ user_id: 'U0STRANGER' }), nowMs: NOW_MS }),
    );
    expect(received.type).toBe('refused_sender');
    expect(received.type === 'refused_sender' ? received.reason : '').toContain('approver list');
  });

  it('allows nobody when the allowlist is empty', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({ payload: clickPayload(), nowMs: NOW_MS }),
      { approver_slack_user_ids: [] },
    );
    expect(received.type).toBe('refused_sender');
  });

  it('gates a denial as well as an approval', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({
        payload: clickPayload({ action_id: SLACK_INTERACTION_ACTIONS.deny, user_id: 'U0STRANGER' }),
        nowMs: NOW_MS,
      }),
    );
    expect(received.type).toBe('refused_sender');
  });

  // Anyone already in the thread could ask the question by typing, so answering is not gated.
  it('does not gate answering a question', async () => {
    const received = await receiveInteraction(
      await slackInteractionRequest({
        payload: clickPayload({
          action_id: `${SLACK_INTERACTION_ACTIONS.answer}0`,
          value: encodeActionValue({ turn_id: TURN_ID, tool_call_id: 'call-q', option: 'staging' }),
          user_id: 'U0STRANGER',
        }),
        nowMs: NOW_MS,
      }),
      { approver_slack_user_ids: [] },
    );
    expect(received.type).toBe('interaction');
  });
});

describe('settleInteraction', () => {
  function recordingFetch(): { fetchImpl: typeof fetch; sent: { url: string; body: unknown }[] } {
    const sent: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response('ok');
    };
    return { fetchImpl, sent };
  }

  it('replaces the message in the channel once a decision is recorded', async () => {
    const { fetchImpl, sent } = recordingFetch();
    const result = await new SlackChannelAdapter({ fetchImpl, now: () => NOW_MS }).settleInteraction({
      manifest: manifest(),
      reply_context: RESPONSE_URL,
      outcome: { type: 'recorded', summary: 'Approved by <@U0ADMIN>.' },
    });

    expect(result).toEqual({ ok: true });
    expect(sent[0]?.url).toBe(RESPONSE_URL);
    expect(sent[0]?.body).toMatchObject({
      response_type: 'in_channel',
      replace_original: true,
      text: 'Approved by <@U0ADMIN>.',
    });
  });

  it('tells only the person who clicked when nothing changed, and leaves the buttons alone', async () => {
    const { fetchImpl, sent } = recordingFetch();
    await new SlackChannelAdapter({ fetchImpl, now: () => NOW_MS }).settleInteraction({
      manifest: manifest(),
      reply_context: RESPONSE_URL,
      outcome: { type: 'refused', reason: 'You are not an approver.' },
    });

    expect(sent[0]?.body).toMatchObject({
      response_type: 'ephemeral',
      replace_original: false,
      text: 'You are not an approver.',
    });
    expect(sent[0]?.body).not.toHaveProperty('blocks');
  });

  it('reports a reply URL Slack refused rather than throwing', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('expired', { status: 404 }));
    const result = await new SlackChannelAdapter({ fetchImpl, now: () => NOW_MS }).settleInteraction({
      manifest: manifest(),
      reply_context: RESPONSE_URL,
      outcome: { type: 'recorded', summary: 'Approved.' },
    });
    expect(result).toEqual({ ok: false, error: 'Slack reply URL returned HTTP 404' });
  });
});
