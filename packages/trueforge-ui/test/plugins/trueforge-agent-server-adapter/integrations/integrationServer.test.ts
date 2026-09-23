import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createTrueForgeClient } from '@/plugins/trueforge-agent-server-adapter/client.js';
import { createIntegrationServer } from '@/plugins/trueforge-agent-server-adapter/integrations/integrationServer.js';

const WIRE_INTEGRATION = {
  id: 'int-1',
  type: 'slack',
  status: 'pending',
  agent_name: 'support-bot',
  external_account_id: 'pending:int-1',
  created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'Alice' },
  created_at: '2026-09-23T10:00:00.000Z',
  updated_at: '2026-09-23T10:00:00.000Z',
  manifest: {
    type: 'slack',
    bot_display_name: 'release-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
  },
};

type Captured = { url: URL; method: string; body: unknown };

/** Records what the SDK actually put on the wire, which is the half the mappers cannot show. */
function recordingServer(respond: (url: URL) => unknown) {
  const calls: Captured[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    });
    return Response.json(respond(url));
  };
  return { calls, server: createIntegrationServer({ client: createTrueForgeClient({ fetch: fetchMock }) }) };
}

describe('createIntegrationServer', () => {
  it('filters the list by agent names joined into one query value', async () => {
    const { calls, server } = recordingServer(() => ({ data: [WIRE_INTEGRATION] }));

    const listed = await server.listIntegrations({ agentNames: ['support-bot', 'release-notes'] });

    assert.equal(calls[0]?.url.pathname, '/api/v1/integrations');
    assert.equal(calls[0]?.url.searchParams.get('agent_names'), 'support-bot,release-notes');
    assert.equal(listed[0]?.agentName, 'support-bot');
    assert.equal(listed[0]?.botDisplayName, 'release-bot');
  });

  it('sends no filter when no agent is named', async () => {
    const { calls, server } = recordingServer(() => ({ data: [] }));

    await server.listIntegrations({ agentNames: [] });

    assert.equal(calls[0]?.url.searchParams.has('agent_names'), false);
  });

  it('creates with the agent beside the manifest, not inside it', async () => {
    const { calls, server } = recordingServer(() => ({ data: WIRE_INTEGRATION }));

    await server.createIntegration({
      type: 'slack',
      agentName: 'support-bot',
      botDisplayName: 'release-bot',
      allowedChannelIds: ['C0GENERAL'],
      allowDirectMessages: true,
      approverUserIds: [],
      notificationRules: [],
    });

    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.url.pathname, '/api/v1/integrations');
    assert.deepEqual(calls[0]?.body, {
      agent_name: 'support-bot',
      manifest: {
        type: 'slack',
        bot_display_name: 'release-bot',
        allowed_channel_ids: ['C0GENERAL'],
        allow_direct_messages: true,
        approver_slack_user_ids: [],
        notification_rules: [],
        reply_mode: 'thread',
      },
    });
  });

  it('updates the manifest alone, since the agent cannot change', async () => {
    const { calls, server } = recordingServer(() => ({ data: WIRE_INTEGRATION }));

    await server.updateIntegration({
      id: 'int-1',
      botDisplayName: 'release-bot',
      allowedChannelIds: ['C0GENERAL'],
      allowDirectMessages: true,
      approverUserIds: [],
      notificationRules: [],
    });

    assert.equal(calls[0]?.method, 'PUT');
    assert.equal(calls[0]?.url.pathname, '/api/v1/integrations/int-1');
    assert.deepEqual(Object.keys(Object(calls[0]?.body)), ['manifest']);
  });
});
