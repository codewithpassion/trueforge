import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import winston from 'winston';
import { createIntegrationEventsRouter } from '../../../src/apis/integrationEvents';
import { createIntegrationsRouter } from '../../../src/apis/integrations';
import { createAppErrorHandler } from '../../../src/app';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import type { IIntegrationStore } from '../../../src/db/integrationStore';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteIntegrationStore } from '../../../src/db/sqlite/integration-store/SqliteIntegrationStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { Database } from '../../../src/db/sqlite/types';
import { createIntegrationAdapters, type IntegrationAdapterRegistry } from '../../../src/integrations/registry';
import type { SlackAuthTest } from '../../../src/integrations/slack/api';
import type { ChannelAdapter, InboundResult } from '../../../src/integrations/types';
import type { Integration, IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { SECRET_REDACTION, toRedactedSecretValue } from '../../../src/utils/secretRedaction';
import { RecordingTurnExecutor } from '../integrations/recordingTurnExecutor';
import { slackRequest } from '../integrations/slack/slackRequest';

const TENANT = STANDALONE_REQUEST_CONTEXT.tenant_id;
const AGENT_NAME = 'support-bot';
const BOT_TOKEN = 'xoxb-super-secret-token';
const SIGNING_SECRET = 'signing-super-secret';

const CREATED_BY: CreatedBySubject = {
  subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
  subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'trueforge',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    default_agent_name: AGENT_NAME,
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    auth: { bot_token: BOT_TOKEN, signing_secret: SIGNING_SECRET },
    ...overrides,
  };
}

/** What the Settings form posts: a bot name and an agent, nothing Slack has issued yet. */
function pendingManifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'release-bot',
    default_agent_name: AGENT_NAME,
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    ...overrides,
  };
}

function jsonInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

interface Harness {
  db: Kysely<Database>;
  integrationStore: IIntegrationStore<Kysely<Database>>;
  settings: ReturnType<typeof createIntegrationsRouter>;
  authTestCalls: string[];
}

const PUBLIC_BASE_URL = 'https://trueforge.test';

async function createHarness(
  options: { slackAuthTest?: SlackAuthTest; publicBaseUrl?: () => string } = {},
): Promise<Harness> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const integrationStore = new SqliteIntegrationStore(db, new BetterSqliteAtomicRunner(db));
  const authTestCalls: string[] = [];
  // Never the real client: a unit test that reached slack.com would be asserting on Slack.
  const slackAuthTest: SlackAuthTest =
    options.slackAuthTest ??
    (async input => {
      authTestCalls.push(input.botToken);
      return { ok: true, team_id: 'T0TEAM', bot_user_id: 'U0BOT' };
    });
  const settings = createIntegrationsRouter({
    resolveIntegrationStore: () => integrationStore,
    withTransaction: callback => db.transaction().execute(callback),
    resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    publicBaseUrl: options.publicBaseUrl ?? (() => PUBLIC_BASE_URL),
    slackAuthTest,
  });
  return { db, integrationStore, settings, authTestCalls };
}

async function createIngress(options: { adapters: IntegrationAdapterRegistry; pending?: boolean }) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const atomic = new BetterSqliteAtomicRunner(db);
  const sessionStore = new SqliteSessionStore(db, atomic);
  const integrationStore = new SqliteIntegrationStore(db, atomic);
  const agentStore = new SqliteAgentStore(db);
  await agentStore.createAgent({
    tenant_id: TENANT,
    name: AGENT_NAME,
    description: AGENT_NAME,
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
    external_id: null,
    created_by_subject: CREATED_BY,
  });
  const integrationId = newId();
  const integration = await integrationStore.createIntegration({
    id: integrationId,
    tenant_id: TENANT,
    type: 'slack',
    external_account_id: options.pending === true ? `pending:${integrationId}` : 'T0TEAM',
    manifest: options.pending === true ? pendingManifest() : manifest(),
    created_by_subject: CREATED_BY,
  });
  const executor = new RecordingTurnExecutor(sessionStore);
  const router = createIntegrationEventsRouter({
    integrationStore,
    adapters: options.adapters,
    sessions: new Sessions({ sessionStore }),
    turnExecutor: executor,
    // The recording executor ignores these; the real stores keep the shape honest.
    resolveModelProviderStore: () => new SqliteModelProviderStore(db),
    resolveMcpServerStore: () =>
      new McpServerWithAuthStore({
        store: new SqliteMcpServerStore(db, atomic),
        tokenStore: new SqliteOAuthTokenStore(db),
        clientName: 'trueforge-tests',
      }),
    resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
    agentStore,
    turnSkillsResolverStore: new SqliteSkillStore(db),
    logger: winston.createLogger({ silent: true }),
  });
  // Behind the server's error handler, so a thrown HTTPException renders the error envelope.
  const app = new OpenAPIHono();
  app.onError(createAppErrorHandler({ logger: winston.createLogger({ silent: true }) }));
  app.route('/', router);
  return { db, app, integration, executor, integrationStore };
}

function slackAdapter(receive: () => InboundResult): IntegrationAdapterRegistry {
  const adapter: ChannelAdapter = {
    type: 'slack',
    receive: () => Promise.resolve(receive()),
    deliver: () => Promise.resolve({ ok: true }),
    notice: () => Promise.resolve({ ok: true }),
  };
  return new Map([['slack', adapter]]);
}

describe('settings integrations router', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  it('creates an integration and redacts both credentials on read', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: Integration };
    expect(body.data.external_account_id).toBe('T0TEAM');
    expect(body.data.manifest.auth).toEqual({
      bot_token: toRedactedSecretValue(BOT_TOKEN),
      signing_secret: toRedactedSecretValue(SIGNING_SECRET),
    });
    expect(body.data.created_by_subject).toEqual(CREATED_BY);

    const listed = await harness.settings.request('/');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ data: [body.data] });

    const fetched = await harness.settings.request(`/${body.data.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ data: body.data });
  });

  it('rejects a create whose credentials are redacted stand-ins', async () => {
    harness = await createHarness();
    const response = await harness.settings.request(
      '/',
      jsonInit('POST', { manifest: manifest({ auth: { bot_token: SECRET_REDACTION, signing_secret: 'real' } }) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('Integration credentials are required') },
    });
  });

  it('returns 409 when the same channel account is connected twice', async () => {
    harness = await createHarness();
    expect((await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }))).status).toBe(201);
    const clash = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    expect(clash.status).toBe(409);
  });

  it('keeps stored credentials when a PUT sends redacted stand-ins', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const updated = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', {
        manifest: manifest({
          allowed_channel_ids: ['C0GENERAL', 'C0RANDOM'],
          auth: {
            bot_token: toRedactedSecretValue(BOT_TOKEN),
            signing_secret: toRedactedSecretValue(SIGNING_SECRET),
          },
        }),
      }),
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { data: Integration };
    expect(updatedBody.data.manifest.allowed_channel_ids).toEqual(['C0GENERAL', 'C0RANDOM']);

    const stored = await harness.integrationStore.getIntegration({ tenant_id: TENANT, id: data.id });
    expect(stored?.manifest.auth).toEqual({ bot_token: BOT_TOKEN, signing_secret: SIGNING_SECRET });
  });

  it('rotates a credential when a PUT sends a real value', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const updated = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', {
        manifest: manifest({
          auth: { bot_token: 'xoxb-rotated-token', signing_secret: toRedactedSecretValue(SIGNING_SECRET) },
        }),
      }),
    );
    expect(updated.status).toBe(200);

    const stored = await harness.integrationStore.getIntegration({ tenant_id: TENANT, id: data.id });
    expect(stored?.manifest.auth).toEqual({ bot_token: 'xoxb-rotated-token', signing_secret: SIGNING_SECRET });
  });

  it('refuses to move to another channel account with a redacted credential', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    const { data } = (await created.json()) as { data: Integration };

    // Keeping the old workspace's token against a new workspace could never authenticate.
    const response = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', {
        manifest: manifest({
          team_id: 'T0OTHER',
          auth: {
            bot_token: toRedactedSecretValue(BOT_TOKEN),
            signing_secret: toRedactedSecretValue(SIGNING_SECRET),
          },
        }),
      }),
    );
    expect(response.status).toBe(400);

    const stored = await harness.integrationStore.getIntegration({ tenant_id: TENANT, id: data.id });
    expect(stored?.external_account_id).toBe('T0TEAM');
    expect(stored?.manifest.auth).toEqual({ bot_token: BOT_TOKEN, signing_secret: SIGNING_SECRET });
  });

  it('creates a pending integration from a bot name alone, and asks Slack nothing', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: pendingManifest() }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: Integration };
    expect(data.status).toBe('pending');
    expect(data.manifest.team_id).toBeUndefined();
    expect(data.manifest.bot_user_id).toBeUndefined();
    expect(data.manifest.auth).toBeUndefined();
    // No channel account yet, so the row stands on its own id rather than colliding.
    expect(data.external_account_id).toBe(`pending:${data.id}`);
    expect(harness.authTestCalls).toEqual([]);
  });

  it('lets two pending integrations coexist', async () => {
    harness = await createHarness();
    expect((await harness.settings.request('/', jsonInit('POST', { manifest: pendingManifest() }))).status).toBe(201);
    expect((await harness.settings.request('/', jsonInit('POST', { manifest: pendingManifest() }))).status).toBe(201);
  });

  it('fills the workspace and bot ids from auth.test when credentials are saved', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: pendingManifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const connected = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', {
        manifest: pendingManifest({ auth: { bot_token: BOT_TOKEN, signing_secret: SIGNING_SECRET } }),
      }),
    );
    expect(connected.status).toBe(200);
    const body = (await connected.json()) as { data: Integration };
    expect(body.data.status).toBe('connected');
    expect(body.data.manifest.team_id).toBe('T0TEAM');
    expect(body.data.manifest.bot_user_id).toBe('U0BOT');
    expect(body.data.external_account_id).toBe('T0TEAM');
    expect(harness.authTestCalls).toEqual([BOT_TOKEN]);
  });

  it('answers 502 when Slack refuses the bot token, and stays pending', async () => {
    harness = await createHarness({
      slackAuthTest: async () => ({ ok: false, error: 'Slack rejected the bot token: invalid_auth' }),
    });
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: pendingManifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const response = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', {
        manifest: pendingManifest({ auth: { bot_token: 'xoxb-wrong', signing_secret: SIGNING_SECRET } }),
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('invalid_auth') } });

    const stored = await harness.integrationStore.getIntegration({ tenant_id: TENANT, id: data.id });
    expect(stored?.manifest.auth).toBeUndefined();
  });

  it('edits a connected integration from the settings form alone, which sends no ids', async () => {
    // Exactly the request the Settings section makes: no workspace, no bot user, no credentials.
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const updated = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', { manifest: pendingManifest({ allowed_channel_ids: ['C0GENERAL', 'C0RANDOM'] }) }),
    );
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { data: Integration };
    expect(body.data.status).toBe('connected');
    expect(body.data.external_account_id).toBe('T0TEAM');
    expect(body.data.manifest.team_id).toBe('T0TEAM');
    expect(body.data.manifest.bot_user_id).toBe('U0BOT');
    expect(body.data.manifest.allowed_channel_ids).toEqual(['C0GENERAL', 'C0RANDOM']);
    // Nothing was rotated, so Slack was only asked at create time.
    expect(harness.authTestCalls).toEqual([BOT_TOKEN]);

    const stored = await harness.integrationStore.getIntegration({ tenant_id: TENANT, id: data.id });
    expect(stored?.manifest.auth).toEqual({ bot_token: BOT_TOKEN, signing_secret: SIGNING_SECRET });
  });

  it('answers 409 when the credentials name a workspace other than the one claimed', async () => {
    harness = await createHarness({
      slackAuthTest: async () => ({ ok: true, team_id: 'T0OTHER', bot_user_id: 'U0OTHERBOT' }),
    });
    const response = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('T0OTHER') } });
  });

  it('answers 409 when a rotated token would move a connected integration to another workspace', async () => {
    let teamId = 'T0TEAM';
    harness = await createHarness({
      slackAuthTest: async () => ({ ok: true, team_id: teamId, bot_user_id: 'U0BOT' }),
    });
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    const { data } = (await created.json()) as { data: Integration };

    teamId = 'T0OTHER';
    const rotated = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', {
        manifest: pendingManifest({ auth: { bot_token: 'xoxb-other', signing_secret: 'other-secret' } }),
      }),
    );
    expect(rotated.status).toBe(409);

    const stored = await harness.integrationStore.getIntegration({ tenant_id: TENANT, id: data.id });
    expect(stored?.external_account_id).toBe('T0TEAM');
    expect(stored?.manifest.auth).toEqual({ bot_token: BOT_TOKEN, signing_secret: SIGNING_SECRET });
  });

  it('serves an app manifest carrying the bot name and this integration ingress URL', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: pendingManifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const response = await harness.settings.request(`/${data.id}/app-manifest`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { request_url: string; manifest_json: string } };
    expect(body.data.request_url).toBe(`${PUBLIC_BASE_URL}/api/v1/integrations/${data.id}/events`);
    const parsed: unknown = JSON.parse(body.data.manifest_json);
    expect(parsed).toMatchObject({
      display_information: { name: 'release-bot' },
      settings: { event_subscriptions: { request_url: body.data.request_url } },
    });
  });

  it('answers 500 for the app manifest when no public base URL is configured', async () => {
    harness = await createHarness({
      publicBaseUrl: () => {
        throw new Error('PUBLIC_BASE_URL is required for OIDC callbacks but was empty');
      },
    });
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: pendingManifest() }));
    const { data } = (await created.json()) as { data: Integration };
    expect((await harness.settings.request(`/${data.id}/app-manifest`)).status).toBe(500);
  });

  it('returns 404 for an unknown integration on GET and PUT', async () => {
    harness = await createHarness();
    expect((await harness.settings.request('/missing')).status).toBe(404);
    expect((await harness.settings.request('/missing', jsonInit('PUT', { manifest: manifest() }))).status).toBe(404);
  });

  it('delete is idempotent and stops listing the integration', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const deleted = await harness.settings.request(`/${data.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});
    expect((await harness.settings.request(`/${data.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await (await harness.settings.request('/')).json()).toEqual({ data: [] });
  });
});

describe('integration events ingress', () => {
  it('returns 404 for an unknown integration', async () => {
    const { db, app } = await createIngress({ adapters: createIntegrationAdapters() });
    try {
      const response = await app.request('/missing/events', { method: 'POST' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { message: 'Integration not found: missing' } });
    } finally {
      await db.destroy();
    }
  });

  it('returns 501 for a type with no adapter registered', async () => {
    // A registry without this channel stands in for a manifest type whose adapter has not landed.
    const { db, app, integration } = await createIngress({ adapters: new Map() });
    try {
      const response = await app.request(`/${integration.id}/events`, { method: 'POST' });
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: { message: 'No adapter for integration type slack' } });
    } finally {
      await db.destroy();
    }
  });

  it('answers with the adapter reply for a channel handshake', async () => {
    const adapters = slackAdapter(() => ({
      type: 'respond',
      status: 200,
      content_type: 'text/plain',
      body: 'challenge-token',
    }));
    const { db, app, integration, executor } = await createIngress({ adapters });
    try {
      const response = await app.request(`/${integration.id}/events`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('challenge-token');
      expect(executor.starts).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('returns 401 when the adapter rejects the signature', async () => {
    const adapters = slackAdapter(() => ({ type: 'rejected', reason: 'bad signature' }));
    const { db, app, integration, executor } = await createIngress({ adapters });
    try {
      const response = await app.request(`/${integration.id}/events`, { method: 'POST' });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { message: 'bad signature' } });
      expect(executor.starts).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('acknowledges an ignored event without starting a turn', async () => {
    const adapters = slackAdapter(() => ({ type: 'ignore', reason: 'message from a bot' }));
    const { db, app, integration, executor } = await createIngress({ adapters });
    try {
      expect((await app.request(`/${integration.id}/events`, { method: 'POST' })).status).toBe(200);
      expect(executor.starts).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('runs the turn as the admin who connected the integration', async () => {
    const adapters = slackAdapter(() => ({
      type: 'event',
      event: {
        integration_id: 'from-path',
        conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100',
        sender: { id: 'U0HUMAN', display_name: 'Ada' },
        text: 'status?',
        attachment_urls: [],
        event_id: 'Ev0001',
      },
    }));
    const { db, app, integration, executor, integrationStore } = await createIngress({ adapters });
    try {
      expect((await app.request(`/${integration.id}/events`, { method: 'POST' })).status).toBe(200);
      expect(executor.starts).toHaveLength(1);
      expect(executor.starts[0]?.userRef).toBe(CREATED_BY.subject_id);
      expect(executor.starts[0]?.session.record.created_by_subject).toEqual(CREATED_BY);

      // A channel retry of the same event is acknowledged without a second turn.
      expect((await app.request(`/${integration.id}/events`, { method: 'POST' })).status).toBe(200);
      expect(executor.starts).toHaveLength(1);

      const deliveries = await db.selectFrom('integration_delivery').selectAll().execute();
      expect(deliveries).toHaveLength(1);
      expect(await integrationStore.getPendingDelivery({ turn_id: deliveries[0]?.turn_id ?? '' })).toBeDefined();
    } finally {
      await db.destroy();
    }
  });

  it('runs a signed Slack mention end to end through the registered adapter', async () => {
    const { db, app, integration, executor } = await createIngress({ adapters: createIntegrationAdapters() });
    try {
      const request = await slackRequest({
        url: `https://trueforge.test/${integration.id}/events`,
        signingSecret: SIGNING_SECRET,
        payload: {
          type: 'event_callback',
          team_id: 'T0TEAM',
          event_id: 'Ev0001',
          event: {
            type: 'app_mention',
            user: 'U0HUMAN',
            text: '<@U0BOT> status?',
            ts: '1700000000.000100',
            channel: 'C0GENERAL',
            channel_type: 'channel',
          },
        },
      });

      expect((await app.request(request)).status).toBe(200);
      expect(executor.starts).toHaveLength(1);
      expect(executor.starts[0]?.input).toEqual([{ type: 'user.message', content: 'status?' }]);
      expect(executor.starts[0]?.session.record.external_id).toBe('slack:T0TEAM:C0GENERAL:1700000000.000100');
    } finally {
      await db.destroy();
    }
  });

  it('refuses an unsigned request without touching the outbox', async () => {
    const { db, app, integration, executor } = await createIngress({ adapters: createIntegrationAdapters() });
    try {
      const response = await app.request(`/${integration.id}/events`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(401);
      expect(executor.starts).toHaveLength(0);
      expect(await db.selectFrom('integration_delivery').selectAll().execute()).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it('answers the unsigned request-URL challenge for a pending integration', async () => {
    // Slack sends this while it creates the app from the manifest, before any secret exists.
    const { db, app, integration } = await createIngress({ adapters: createIntegrationAdapters(), pending: true });
    try {
      const response = await app.request(`/${integration.id}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'url_verification', challenge: 'chal-123' }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('chal-123');
    } finally {
      await db.destroy();
    }
  });

  it('refuses a real event for a pending integration with 409', async () => {
    const { db, app, integration, executor } = await createIngress({
      adapters: createIntegrationAdapters(),
      pending: true,
    });
    try {
      const response = await app.request(`/${integration.id}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'event_callback',
          team_id: 'T0TEAM',
          event_id: 'Ev0009',
          event: { type: 'app_mention', user: 'U0HUMAN', text: 'hi', ts: '1.1', channel: 'C0GENERAL' },
        }),
      });
      expect(response.status).toBe(409);
      expect(executor.starts).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('still requires a signature on the challenge once credentials are stored', async () => {
    const { db, app, integration } = await createIngress({ adapters: createIntegrationAdapters() });
    try {
      const response = await app.request(`/${integration.id}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'url_verification', challenge: 'chal-123' }),
      });
      expect(response.status).toBe(401);
    } finally {
      await db.destroy();
    }
  });
});
