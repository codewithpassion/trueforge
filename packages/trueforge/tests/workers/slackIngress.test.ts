import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createIntegrationEventsRouter } from '../../src/apis/integrationEvents';
import { requestContextFromCreatedBySubject } from '../../src/auth/identity';
import { createIntegrationAdapters } from '../../src/integrations/registry';
import type { IntegrationManifest } from '../../src/schemas/integration';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersRuntimeDeps } from '../../src/workers/runtime';
import { SLACK_TEST_SIGNING_SECRET, slackRequest } from '../unit/integrations/slack/slackRequest';
import { d1Persistence, migrateDatabase, sessionStub, TENANT_ID, upsertMockProvider, USER_REF } from './harness';

/** Everything the Slack adapter posted, captured from inside the Worker and its Durable Objects. */
const posted = vi.hoisted((): { channel: string; thread_ts: string; text: string }[] => []);

// The real adapter runs; only its `fetch` is replaced, because the Workers pool refuses any
// outbound request that is not the mock model. SessionDO builds its own registry, so the
// module is mocked rather than injected.
vi.mock('../../src/integrations/registry', async () => {
  const { SlackChannelAdapter } = await import('../../src/integrations/slack/SlackChannelAdapter');
  const fetchImpl: typeof fetch = async (_input, init) => {
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  };
  return {
    createIntegrationAdapters: () => new Map([['slack', new SlackChannelAdapter({ fetchImpl })]]),
  };
});

const CREATED_BY: CreatedBySubject = {
  subject_id: USER_REF,
  subject_type: 'user',
  subject_display_name: USER_REF,
};

const REQUEST_CONTEXT = requestContextFromCreatedBySubject({
  tenant_id: TENANT_ID,
  created_by_subject: CREATED_BY,
});

const AGENT_NAME = 'slack-support-bot';
const TEAM_ID = 'T0TEAM';
const CHANNEL_ID = 'C0GENERAL';

function manifest(teamId: string): IntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'trueforge',
    team_id: teamId,
    bot_user_id: 'U0BOT',
    allowed_channel_ids: [CHANNEL_ID],
    allow_direct_messages: true,
    reply_mode: 'thread',
    approver_slack_user_ids: [],
    notification_rules: [],
    auth: { bot_token: 'xoxb-workers-test', signing_secret: SLACK_TEST_SIGNING_SECRET },
  };
}

/** Channel ingress over the real Workers stores and the session Durable Object executor. */
function ingressApp() {
  const { persistence, turnExecutor } = createWorkersRuntimeDeps(env);
  const app = new OpenAPIHono();
  app.route(
    '/api/v1/integrations',
    createIntegrationEventsRouter({
      integrationStore: persistence.integrationStore,
      adapters: createIntegrationAdapters(),
      sessions: new Sessions({ sessionStore: persistence.sessionStore }),
      turnExecutor,
      // D1 stores are not caller-scoped, so the request context the app derives is not needed here.
      resolveModelProviderStore: () => persistence.resolveModelProviderStore(REQUEST_CONTEXT),
      resolveMcpServerStore: () => persistence.resolveMcpServerStore(REQUEST_CONTEXT),
      resolveSandboxProviderStore: () => persistence.resolveSandboxProviderStore(REQUEST_CONTEXT),
      agentStore: persistence.agentStore,
      scheduleStore: persistence.scheduleStore,
      turnSkillsResolverStore: persistence.turnSkillsResolverStore,
      logger: createConsoleLogger({ level: 'error', bindings: {} }),
    }),
  );
  return app;
}

async function connectSlack(input: { integrationId: string; teamId: string }): Promise<void> {
  const stores = d1Persistence();
  const agent = await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: AGENT_NAME });
  if (agent === undefined) {
    throw new Error(`agent ${AGENT_NAME} was not seeded`);
  }
  await stores.integrationStore.createIntegration({
    id: input.integrationId,
    tenant_id: TENANT_ID,
    agent_id: agent.id,
    agent_name: agent.name,
    type: 'slack',
    external_account_id: input.teamId,
    manifest: manifest(input.teamId),
    created_by_subject: CREATED_BY,
  });
}

function mentionPayload(input: { eventId: string; threadTs: string; teamId?: string }) {
  return {
    type: 'event_callback',
    team_id: input.teamId ?? TEAM_ID,
    event_id: input.eventId,
    event: {
      type: 'app_mention',
      user: 'U0HUMAN',
      text: '<@U0BOT> what is the status?',
      ts: input.threadTs,
      channel: CHANNEL_ID,
      channel_type: 'channel',
    },
  };
}

async function postToIngress(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await ingressApp().fetch(request, env, ctx);
  // Drains the post-start delivery flush the route handed to `waitUntil`.
  await waitOnExecutionContext(ctx);
  return response;
}

function ingressUrl(integrationId: string): string {
  return `https://trueforge.test/api/v1/integrations/${integrationId}/events`;
}

beforeAll(async () => {
  await migrateDatabase();
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: 'text' });
  await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: AGENT_NAME,
    description: AGENT_NAME,
    manifest: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
    external_id: null,
    created_by_subject: CREATED_BY,
  });
});

beforeEach(() => {
  posted.length = 0;
});

describe('Slack ingress on Workers', () => {
  it('answers the subscription challenge without starting anything', async () => {
    const integrationId = 'int-challenge';
    await connectSlack({ integrationId, teamId: 'T0CHALLENGE' });

    const response = await postToIngress(
      await slackRequest({
        url: ingressUrl(integrationId),
        payload: { type: 'url_verification', challenge: 'chal-workers', token: 'tok' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('chal-workers');
    expect(posted).toEqual([]);
  });

  it('refuses a request signed with the wrong secret', async () => {
    const integrationId = 'int-badsig';
    await connectSlack({ integrationId, teamId: 'T0BADSIG' });

    const response = await postToIngress(
      await slackRequest({
        url: ingressUrl(integrationId),
        payload: mentionPayload({ eventId: 'Ev-bad', threadTs: '1700000000.000300', teamId: 'T0BADSIG' }),
        signingSecret: 'not-the-signing-secret',
      }),
    );

    expect(response.status).toBe(401);
    expect(posted).toEqual([]);
  });

  it('runs a mention as a turn and posts the answer back into its thread', async () => {
    const integrationId = 'int-mention';
    const threadTs = '1700000000.000100';
    const conversationKey = `slack:${TEAM_ID}:${CHANNEL_ID}:${threadTs}`;
    await connectSlack({ integrationId, teamId: TEAM_ID });
    const stores = d1Persistence();

    const response = await postToIngress(
      await slackRequest({
        url: ingressUrl(integrationId),
        payload: mentionPayload({ eventId: 'Ev-mention', threadTs }),
      }),
    );
    expect(response.status).toBe(200);

    const session = await stores.sessionStore.getSessionByExternalId({
      tenant_id: TENANT_ID,
      external_id: conversationKey,
    });
    if (session === undefined) {
      throw new Error('the mention did not open a session');
    }
    expect(session.source).toEqual({ type: 'integration', id: integrationId, conversation_key: conversationKey });
    expect(session.metadata).toMatchObject({ 'integration.sender_id': 'U0HUMAN' });

    // The alarm holds the turn until its drain settles, so delivery runs before this returns.
    await runInDurableObject(sessionStub(session.session_id), instance => instance.alarm());

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: CHANNEL_ID, thread_ts: threadTs });
    expect(posted[0]?.text).toContain('Hello from the mock model.');

    // A Slack retry of the same event id is acknowledged and changes nothing.
    const retry = await postToIngress(
      await slackRequest({
        url: ingressUrl(integrationId),
        payload: mentionPayload({ eventId: 'Ev-mention', threadTs }),
      }),
    );
    expect(retry.status).toBe(200);
    expect(posted).toHaveLength(1);
  });
});
