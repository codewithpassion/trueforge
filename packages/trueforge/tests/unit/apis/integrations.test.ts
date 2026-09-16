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
import type { ChannelAdapter, InboundResult } from '../../../src/integrations/types';
import type { Integration, IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { SECRET_REDACTION, toRedactedSecretValue } from '../../../src/utils/secretRedaction';
import { RecordingTurnExecutor } from '../integrations/recordingTurnExecutor';

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

function jsonInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

interface Harness {
  db: Kysely<Database>;
  integrationStore: IIntegrationStore<Kysely<Database>>;
  settings: ReturnType<typeof createIntegrationsRouter>;
}

async function createHarness(): Promise<Harness> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const integrationStore = new SqliteIntegrationStore(db, new BetterSqliteAtomicRunner(db));
  const settings = createIntegrationsRouter({
    resolveIntegrationStore: () => integrationStore,
    withTransaction: callback => db.transaction().execute(callback),
    resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
  });
  return { db, integrationStore, settings };
}

async function createIngress(options: { adapters: IntegrationAdapterRegistry }) {
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
  const integration = await integrationStore.createIntegration({
    id: newId(),
    tenant_id: TENANT,
    type: 'slack',
    external_account_id: 'T0TEAM',
    manifest: manifest(),
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

  it('allows moving to another channel account with real credentials', async () => {
    harness = await createHarness();
    const created = await harness.settings.request('/', jsonInit('POST', { manifest: manifest() }));
    const { data } = (await created.json()) as { data: Integration };

    const response = await harness.settings.request(
      `/${data.id}`,
      jsonInit('PUT', {
        manifest: manifest({
          team_id: 'T0OTHER',
          auth: { bot_token: 'xoxb-other', signing_secret: 'other-secret' },
        }),
      }),
    );
    expect(response.status).toBe(200);

    const stored = await harness.integrationStore.getIntegration({ tenant_id: TENANT, id: data.id });
    expect(stored?.external_account_id).toBe('T0OTHER');
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
    const { db, app, integration } = await createIngress({ adapters: createIntegrationAdapters() });
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
});
