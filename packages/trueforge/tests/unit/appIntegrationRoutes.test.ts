import {
  AgentSpecSchema,
  InMemorySessionStore,
  Sessions,
  type CreatedBySubject,
} from '@truefoundry/trueforge-core/agent-session';
import { HTTPException } from 'hono/http-exception';
import type { Kysely } from 'kysely';
import winston from 'winston';
import { buildOpenApiDocument, createServerApp } from '../../src/app';
import type { Authenticator } from '../../src/auth/authenticator';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import { McpCatalog } from '../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../src/catalog/SkillCatalog';
import configuration from '../../src/config';
import { McpServerWithAuthStore } from '../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../src/db/sqlite/client';
import { SqliteIntegrationStore } from '../../src/db/sqlite/integration-store/SqliteIntegrationStore';
import { SqliteMcpServerStore } from '../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteScheduleStore } from '../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionMetricsStore } from '../../src/db/sqlite/session-metrics/SqliteSessionMetricsStore';
import { SqliteSkillStore } from '../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { Database } from '../../src/db/sqlite/types';
import { SLACK_TEST_SIGNING_SECRET, slackRequest } from './integrations/slack/slackRequest';
import { testNodeTurnExecutor } from './runtime/testNodeTurnExecutor';

const TENANT = 'default';
const INTEGRATION_ID = 'int-mounted';
const PREFIX = '/api/v1/integrations';
const CREATED_BY: CreatedBySubject = { subject_id: 'owner', subject_type: 'user', subject_display_name: 'Owner' };

/** Every request is unauthenticated, the way a caller without a TrueForge credential looks. */
const rejectingAuthenticator: Authenticator = {
  authenticate: () => Promise.reject(new HTTPException(401, { message: 'Authentication required' })),
};

async function seed(db: Kysely<Database>): Promise<void> {
  const agent = await new SqliteAgentStore(db).createAgent({
    tenant_id: TENANT,
    name: 'support-bot',
    description: 'support-bot',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
    external_id: null,
    created_by_subject: CREATED_BY,
  });
  await new SqliteIntegrationStore(db, new BetterSqliteAtomicRunner(db)).createIntegration({
    id: INTEGRATION_ID,
    tenant_id: TENANT,
    agent_id: agent.id,
    agent_name: agent.name,
    type: 'slack',
    external_account_id: 'T0TEAM',
    manifest: {
      type: 'slack',
      bot_display_name: 'trueforge',
      team_id: 'T0TEAM',
      bot_user_id: 'U0BOT',
      allowed_channel_ids: ['C0GENERAL'],
      allow_direct_messages: true,
      reply_mode: 'thread',
      approver_slack_user_ids: [],
      notification_rules: [],
      auth: { bot_token: 'xoxb-test', signing_secret: SLACK_TEST_SIGNING_SECRET },
    },
    created_by_subject: CREATED_BY,
  });
}

async function createApp() {
  const sessionStore = new InMemorySessionStore();
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  await seed(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  const agentStore = new SqliteAgentStore(db);
  const skillStore = new SqliteSkillStore(db);
  const sandboxProviderStore = new SqliteSandboxProviderStore(db);
  const app = createServerApp({
    modelCatalog: ModelCatalog.load(),
    mcpCatalog: McpCatalog.load(),
    skillCatalog: SkillCatalog.load(),
    sandboxCatalog: SandboxCatalog.load(),
    resolveModelProviderStore: () => new SqliteModelProviderStore(db),
    resolveMcpServerStore: () =>
      new McpServerWithAuthStore({
        store: new SqliteMcpServerStore(db, new BetterSqliteAtomicRunner(db)),
        tokenStore,
        clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
      }),
    resolveSkillStore: () => skillStore,
    resolveSandboxProviderStore: () => sandboxProviderStore,
    sandboxIntegration: undefined,
    computers: undefined,
    clientCertificateMiddleware: undefined,
    sessionImport: undefined,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    agentStore,
    turnSkillsResolverStore: skillStore,
    withTransaction: callback => db.transaction().execute(callback),
    scheduleStore: new SqliteScheduleStore(db, new BetterSqliteAtomicRunner(db)),
    integrationStore: new SqliteIntegrationStore(db, new BetterSqliteAtomicRunner(db)),
    tokenStore,
    sessionStore,
    sessionMetricsStore: new SqliteSessionMetricsStore(db),
    sessions: new Sessions({ sessionStore }),
    turnExecutor: testNodeTurnExecutor({ sandboxIntegration: undefined }),
    logger: winston.createLogger({ silent: true }),
    oidcClient: undefined,
    authenticator: rejectingAuthenticator,
    authorizer: new TrueForgeAuthorizer(),
  });
  return { app, db };
}

const METHODS = ['get', 'post', 'put', 'delete'] as const;

describe('integration routes as mounted on the server app', () => {
  it('lets a signed Slack event reach ingress with no TrueForge credential', async () => {
    const { app, db } = await createApp();
    try {
      const request = await slackRequest({
        url: `https://trueforge.test${PREFIX}/${INTEGRATION_ID}/events`,
        payload: { type: 'url_verification', challenge: 'chal-mounted' },
      });

      const response = await app.request(request);

      // The challenge only comes back once the adapter has verified the signature.
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('chal-mounted');
    } finally {
      await db.destroy();
    }
  });

  it('answers 401 on every CRUD operation without a credential', async () => {
    const { app, db } = await createApp();
    try {
      const paths = buildOpenApiDocument(app).paths ?? {};
      const operations: string[] = [];
      for (const [path, item] of Object.entries(paths)) {
        if (!path.startsWith(PREFIX) || path.endsWith('/events') || path.endsWith('/interactions')) {
          continue;
        }
        for (const method of METHODS) {
          if (item[method] === undefined) {
            continue;
          }
          const url = path.replace('{integration_id}', INTEGRATION_ID);
          const response = await app.request(url, {
            method: method.toUpperCase(),
            headers: { 'content-type': 'application/json' },
            ...(method === 'post' || method === 'put' ? { body: '{}' } : {}),
          });
          expect({ operation: `${method} ${path}`, status: response.status }).toEqual({
            operation: `${method} ${path}`,
            status: 401,
          });
          operations.push(`${method} ${path}`);
        }
      }
      // list, create, get, update, delete, app manifest, decisions.
      expect(operations).toHaveLength(7);
    } finally {
      await db.destroy();
    }
  });
});
