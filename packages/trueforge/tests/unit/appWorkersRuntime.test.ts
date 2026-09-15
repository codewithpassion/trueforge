import { InMemorySessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';
import { buildOpenApiDocument, createServerApp } from '../../src/app';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import { createApiKeyAuthMiddleware } from '../../src/auth/middleware';
import { StandaloneAuthenticator } from '../../src/auth/standaloneAuthenticator';
import { McpCatalog } from '../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../src/catalog/SkillCatalog';
import configuration, { parseServerConfiguration } from '../../src/config';
import { McpServerWithAuthStore } from '../../src/db/McpServerWithAuthStore';
import { SqliteAgentStore } from '../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteScheduleStore } from '../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionMetricsStore } from '../../src/db/sqlite/session-metrics/SqliteSessionMetricsStore';
import { SqliteSkillStore } from '../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { testNodeTurnExecutor } from './runtime/testNodeTurnExecutor';

const EXECUTE_RUN_PATH = '/api/internal/schedules/runs/execute';

jest.mock('../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../src/config')>('../../src/config');
  const workersEnv: Record<string, string> = {
    TRUEFORGE_RUNTIME: 'workers',
    OIDC_ISSUER_URL: 'https://issuer.example.com/',
    OIDC_CLIENT_ID: 'workers-client',
    OIDC_CLIENT_SECRET: 'workers-secret',
    PUBLIC_BASE_URL: 'https://trueforge.example.com',
  };
  const saved = new Map(Object.keys(workersEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, workersEnv);
  try {
    return { ...actual, __esModule: true, default: actual.parseServerConfiguration() };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

jest.mock('../../src/auth/middleware', () => {
  const actual = jest.requireActual<typeof import('../../src/auth/middleware')>('../../src/auth/middleware');
  return { ...actual, createApiKeyAuthMiddleware: jest.fn(actual.createApiKeyAuthMiddleware) };
});

function createApp() {
  const sessionStore = new InMemorySessionStore();
  const db = createSqliteDb(':memory:');
  const tokenStore = new SqliteOAuthTokenStore(db);
  const agentStore = new SqliteAgentStore(db);
  const skillStore = new SqliteSkillStore(db);
  const sandboxProviderStore = new SqliteSandboxProviderStore(db);
  return createServerApp({
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
    clientCertificateMiddleware: undefined,
    sessionImport: undefined,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    agentStore,
    turnSkillsResolverStore: skillStore,
    withTransaction: callback => db.transaction().execute(callback),
    scheduleStore: new SqliteScheduleStore(db, new BetterSqliteAtomicRunner(db)),
    tokenStore,
    sessionStore,
    sessionMetricsStore: new SqliteSessionMetricsStore(db),
    sessions: new Sessions({ sessionStore }),
    turnExecutor: testNodeTurnExecutor({ sandboxIntegration: undefined }),
    logger: winston.createLogger({ silent: true }),
    oidcClient: undefined,
    authenticator: new StandaloneAuthenticator(),
    authorizer: new TrueForgeAuthorizer(),
  });
}

describe('createServerApp on the workers runtime', () => {
  it('builds from a workers configuration', () => {
    expect(configuration.RUNTIME).toBe('workers');
  });

  it('does not mount the internal schedule execution route', async () => {
    const app = createApp();

    const response = await app.request(EXECUTE_RUN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule_run_id: 'run-1' }),
    });

    expect(response.status).toBe(404);
    expect(Object.keys(buildOpenApiDocument(app).paths ?? {})).not.toContain(EXECUTE_RUN_PATH);
  });

  it('does not construct the service API-key middleware', () => {
    jest.mocked(createApiKeyAuthMiddleware).mockClear();
    createApp();

    expect(jest.isMockFunction(createApiKeyAuthMiddleware)).toBe(true);
    expect(createApiKeyAuthMiddleware).not.toHaveBeenCalled();
  });

  // Control: proves the middleware mock intercepts app.ts, so the workers assertion above is meaningful.
  it('constructs the service API-key middleware on a standalone configuration', () => {
    const standaloneConfiguration = parseServerConfiguration();
    expect(standaloneConfiguration.RUNTIME).toBe('standalone');
    const replaced = jest.replaceProperty(
      jest.requireMock<typeof import('../../src/config')>('../../src/config'),
      'default',
      standaloneConfiguration,
    );
    jest.mocked(createApiKeyAuthMiddleware).mockClear();
    try {
      createApp();
    } finally {
      replaced.restore();
    }

    expect(createApiKeyAuthMiddleware).toHaveBeenCalledTimes(1);
  });
});
