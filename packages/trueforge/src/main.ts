/**
 * Server entry point: validates config, migrates the selected database, wires
 * stores, and starts the HTTP server. Any config, migration, or store error
 * aborts startup.
 *
 * `STANDALONE=true` (default): SQLite, no Redis. `STANDALONE=false`: Postgres + Redis.
 *
 * Config is validated at import time (`./config`). Runtime startup failures
 * (migrate, Redis, listen) are caught below and exit non-zero. SQLite vs
 * Postgres store modules stay dynamic so only the active engine is loaded.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Context } from 'hono';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ensureLocalSandboxRootParent,
  prepareCodeModeSocketParent,
  removeCodeModeSocketParent,
} from './sandbox/localLifecycle';

let configuration: NodeServerConfiguration;
let isOidcConfigured: typeof import('./config').isOidcConfigured;
let isTrueFoundryModeEnabled: typeof import('./config').isTrueFoundryModeEnabled;
let getTrueForgeAuthMode: typeof import('./config').getTrueForgeAuthMode;
let getPublicUiBasePath: typeof import('./config').getPublicUiBasePath;
let TrueForgeAuthMode: typeof import('./config').TrueForgeAuthMode;

try {
  const loaded = await import('./config');
  const loadedConfiguration = loaded.default;
  if (loadedConfiguration.RUNTIME === 'workers') {
    throw new Error('TRUEFORGE_RUNTIME=workers runs only in the Workers entry, not the Node server.');
  }
  configuration = loadedConfiguration;
  ({ isOidcConfigured, isTrueFoundryModeEnabled, getTrueForgeAuthMode, getPublicUiBasePath, TrueForgeAuthMode } =
    loaded);
} catch (error) {
  console.error(
    'Failed to start server: Failed to load configuration:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}

import { serve } from '@hono/node-server';
import {
  CancellationReason,
  Sessions,
  type ISessionStore,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { RequestReplyExecutor, RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import type { Kysely, Transaction } from 'kysely';
import type { RedisClientType } from 'redis';

import { createServerApp } from './app';
import { TrueForgeAuthorizer, type Authorizer } from './auth/authorizer';
import { createAuthenticator } from './auth/createAuthenticator';
import { resolveRequestContext, type RequestContext } from './auth/identity';
import { initOidc } from './auth/oidc';
import { McpCatalog } from './catalog/McpCatalog';
import { ModelCatalog } from './catalog/ModelCatalog';
import { SandboxCatalog } from './catalog/SandboxCatalog';
import { SkillCatalog } from './catalog/SkillCatalog';
import { type DistributedServerConfiguration, type NodeServerConfiguration } from './config';
import { createController } from './controller';
import type { AgentRecord, IAgentStore } from './db/agentStore';
import type { IMcpServerStore, IMcpServerWithAuthStore } from './db/mcpServerStore';
import { McpServerWithAuthStore } from './db/McpServerWithAuthStore';
import type { IModelProviderStore } from './db/modelProviderStore';
import type { PostgresAgentStore } from './db/postgres/agent-store/PostgresAgentStore';
import type { Database as PostgresDatabase } from './db/postgres/types';
import type { ISandboxProviderStore } from './db/sandboxProviderStore';
import type { IScheduleStore } from './db/scheduleStore';
import type { SessionImport } from './db/sessionImport';
import type { ISessionMetricsStore } from './db/sessionMetricsStore';
import type { ISkillStore } from './db/skillStore';
import type { Database as SqliteDatabase } from './db/sqlite/types';
import type { WithTransaction } from './db/transaction';
import { mountFrontend } from './frontend';
import { createClientCertificateMiddleware, serverTlsServeOptions } from './http/tls';
import { createServerLogger, shouldColorize } from './logger';
import type { IOAuthTokenStore } from './mcp/auth/types';
import { CODE_MODE_SOCKET_PARENT, FRONTEND_DIR, LOCAL_SANDBOX_ROOT_PARENT, SQLITE_PATH } from './nodeConfig';
import { PACKAGE_VERSION } from './packageVersion.gen';
import { ActiveTurnRegistry } from './runtime/activeTurns';
import { EventSubscriptionRegistry } from './runtime/event-subscription';
import type { SandboxIntegration } from './sandbox/integration';
import type { LocalSandboxSupportResult } from './sandbox/local/provider/LocalSandboxProvider';
import { createNodeSandboxIntegration } from './sandbox/nodeSandboxIntegration';
import { printStandaloneStartupBanner } from './startupBanner';
import {
  parsePerServerMcpHeaders,
  X_TFG_MCP_HEADERS,
  type PerServerMcpHeaders,
} from './truefoundry/perServerMcpHeaders';
import { TrueFoundryAgentStore } from './truefoundry/TrueFoundryAgentStore';
import { TrueFoundryAuthorizer } from './truefoundry/TrueFoundryAuthorizer';
import { TrueFoundryMcpServerStore } from './truefoundry/TrueFoundryMcpServerStore';
import { TrueFoundryModelProviderStore } from './truefoundry/TrueFoundryModelProviderStore';
import { TrueFoundrySandboxProviderStore } from './truefoundry/TrueFoundrySandboxProviderStore';
import { TrueFoundryServiceFoundryServerClient } from './truefoundry/TrueFoundryServiceFoundryServerClient';
import { TrueFoundryAdminSkillStore, TrueFoundrySkillStore } from './truefoundry/TrueFoundrySkillStore';

/** Persistence + optional Redis wired for the selected topology. */
interface ServerPersistence<TTransaction> {
  withTransaction: WithTransaction<TTransaction>;
  sessionStore: ISessionStore;
  /** Postgres only; undefined disables the session import routes. */
  sessionImport: SessionImport | undefined;
  sessionMetricsStore: ISessionMetricsStore;
  tokenStore: IOAuthTokenStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  mcpOAuthStore: IMcpServerWithAuthStore<TTransaction>;
  resolveModelProviderStore: (rc: RequestContext, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction>;
  resolveMcpServerStore: (
    rc: RequestContext,
    runAsAgent?: AgentRecord,
    perServerHeaders?: PerServerMcpHeaders,
  ) => IMcpServerWithAuthStore<TTransaction>;
  resolveSandboxProviderStore: (rc: RequestContext) => ISandboxProviderStore<TTransaction>;
  /** Per-request store: DB git skills, or TrueFoundry registry catalog in TrueFoundry mode. */
  resolveSkillStore: (rc: RequestContext) => ISkillStore<TTransaction>;
  resolveAgentStore: (rc: RequestContext) => IAgentStore<TTransaction>;
  /** Import agents: SF assume-user headers on the client; DB store when TrueFoundry mode is off. */
  resolveImportAgentStore: (serviceFoundryServerHeaders: Record<string, string>) => IAgentStore<TTransaction>;
  /** extra pre-resolved stores for scheduled runs */
  agentStore: IAgentStore<TTransaction>;
  turnSkillsResolverStore: Pick<ISkillStore<TTransaction>, 'resolveTurnSkills'>;
  destroyDb: () => Promise<void>;
  redis: RedisClientType | undefined;
  /** One shared client for TrueFoundry store resolvers + auth; undefined when TrueFoundry mode is off. */
  serviceFoundryClient: TrueFoundryServiceFoundryServerClient | undefined;
}

/** Shared ServiceFoundry HTTP client when TrueFoundry mode is on; otherwise undefined. */
function createServiceFoundryServerClient(
  logger: Logger,
  headers?: Record<string, string>,
): TrueFoundryServiceFoundryServerClient | undefined {
  if (!isTrueFoundryModeEnabled(configuration)) {
    return undefined;
  }
  const apiKey = configuration.TRUEFOUNDRY_API_KEY;
  if (apiKey === undefined) {
    // this is unreachable because the config validation fails if TRUEFOUNDRY_API_KEY is not set
    // we will refactor config itself later to have a truefoundry section where this will be required
    throw new Error('TRUEFOUNDRY_API_KEY is required when TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL is set.');
  }
  return new TrueFoundryServiceFoundryServerClient({
    serviceFoundryServerUrl: configuration.TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL,
    logger,
    httpTimeoutMs: configuration.TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS,
    httpAgentTimeoutMs: configuration.TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS,
    tls: { enabled: configuration.TRUEFOUNDRY_MTLS_ENABLED, dir: configuration.TRUEFOUNDRY_MTLS_CERTS_DIR },
    apiKey,
    ...(headers !== undefined ? { headers } : {}),
  });
}

/** Per-request SFY skill catalog; otherwise {@link persistenceStore}. Caller JWT for list/validate. */
function buildResolveSkillStore<TTransaction>(options: {
  persistenceStore: ISkillStore<TTransaction>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
}): (requestContext: RequestContext) => ISkillStore<TTransaction> {
  const { persistenceStore, client } = options;
  if (client === undefined) {
    return () => persistenceStore;
  }
  return requestContext =>
    new TrueFoundrySkillStore<TTransaction>({
      client,
      context: requestContext,
    });
}

function buildTurnSkillsResolverStore<TTransaction>(options: {
  persistenceStore: ISkillStore<TTransaction>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
}): Pick<ISkillStore<TTransaction>, 'resolveTurnSkills'> {
  const { persistenceStore, client } = options;
  if (client) {
    return new TrueFoundryAdminSkillStore({ client });
  }
  return persistenceStore;
}

/**
 * Per-request model-provider store over a shared ServiceFoundry client, else {@link persistenceStore}.
 * `runAsAgent` is set only when a turn should use a saved agent's token.
 */
function buildResolveModelProviderStore<TTransaction>(options: {
  persistenceStore: IModelProviderStore<TTransaction>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
  logger: Logger;
}): (rc: RequestContext, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction> {
  return (rc, runAsAgent) => {
    const { persistenceStore, client } = options;
    if (client) {
      return new TrueFoundryModelProviderStore<TTransaction>({
        client,
        requestContext: rc,
        agent: runAsAgent,
        logger: options.logger,
      });
    }
    return persistenceStore;
  };
}

/**
 * Per-request MCP store over ServiceFoundry. `runAsAgent` selects a saved agent's token for turns.
 */
function buildResolveMcpServerStore<TTransaction>(options: {
  persistenceStore: IMcpServerStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
  logger: Logger;
}): (
  rc: RequestContext,
  runAsAgent?: AgentRecord,
  perServerHeaders?: PerServerMcpHeaders,
) => IMcpServerWithAuthStore<TTransaction> {
  const withAuthMcpPersistenceStore = new McpServerWithAuthStore<TTransaction>({
    store: options.persistenceStore,
    tokenStore: options.tokenStore,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
  });
  return (rc, runAsAgent, perServerHeaders) => {
    const { client } = options;
    if (client) {
      return new TrueFoundryMcpServerStore<TTransaction>({
        client,
        requestContext: rc,
        agent: runAsAgent,
        logger: options.logger,
        ...(perServerHeaders === undefined ? {} : { perServerHeaders }),
      });
    }
    return withAuthMcpPersistenceStore;
  };
}

/** Per-request agent store decorator over DB persistence, else {@link persistenceStore}. */
function buildResolveAgentStore(options: {
  persistenceStore: PostgresAgentStore;
  db: Kysely<PostgresDatabase>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
}): (rc: RequestContext) => IAgentStore<Transaction<PostgresDatabase>> {
  const { persistenceStore, client, db } = options;
  return rc => {
    if (client) {
      return new TrueFoundryAgentStore({
        inner: persistenceStore,
        client,
        context: rc,
        db,
      });
    }
    return persistenceStore;
  };
}

/**
 * Sandbox-provider store resolver. In TrueFoundry mode the shared env-backed store is reused;
 * otherwise the persistence store is reused as-is.
 */
function buildResolveSandboxProviderStore<TTransaction>(options: {
  persistenceStore: ISandboxProviderStore<TTransaction>;
}): (rc: RequestContext) => ISandboxProviderStore<TTransaction> {
  const { persistenceStore } = options;
  if (isTrueFoundryModeEnabled(configuration)) {
    return () => new TrueFoundrySandboxProviderStore<TTransaction>();
  }
  return () => persistenceStore;
}

/** SQLite stores; Redis unused (executor peering disabled). */
async function createStandalonePersistence(options: {
  sqlitePath: string;
  logger: Logger;
}): Promise<ServerPersistence<Transaction<SqliteDatabase>>> {
  const { sqlitePath, logger } = options;
  await mkdir(path.dirname(sqlitePath), { recursive: true });
  const [{ BetterSqliteAtomicRunner, createSqliteDb }, { migrateSqliteToLatest }, sqliteStores] = await Promise.all([
    import('./db/sqlite/client'),
    import('./db/migrateSqlite'),
    Promise.all([
      import('./db/sqlite/session-store/SqliteSessionStore'),
      import('./db/sqlite/session-metrics/SqliteSessionMetricsStore'),
      import('./db/sqlite/model-provider-store/SqliteModelProviderStore'),
      import('./db/sqlite/mcp-server-store/SqliteMcpServerStore'),
      import('./db/sqlite/token-store/SqliteOAuthTokenStore'),
      import('./db/sqlite/skill-store/SqliteSkillStore'),
      import('./db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore'),
      import('./db/sqlite/agent-store/SqliteAgentStore'),
      import('./db/sqlite/schedule-store/SqliteScheduleStore'),
    ]),
  ]);
  const [
    { SqliteSessionStore },
    { SqliteSessionMetricsStore },
    { SqliteModelProviderStore },
    { SqliteMcpServerStore },
    { SqliteOAuthTokenStore },
    { SqliteSkillStore },
    { SqliteSandboxProviderStore },
    { SqliteAgentStore },
    { SqliteScheduleStore },
  ] = sqliteStores;

  const db = createSqliteDb(sqlitePath);
  await migrateSqliteToLatest(db);
  logger.info(`Standalone mode: sqlite at ${sqlitePath}`);
  logger.info('Standalone mode: executor peering disabled and Redis unused');

  const tokenStore = new SqliteOAuthTokenStore(db);
  const agentStore = new SqliteAgentStore(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  const mcpServerStore = new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db, new BetterSqliteAtomicRunner(db)),
    tokenStore,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
  });
  const sandboxProviderStore = new SqliteSandboxProviderStore(db);
  const skillStore = new SqliteSkillStore(db);
  return {
    withTransaction: callback => db.transaction().execute(callback),
    sessionStore: new SqliteSessionStore(db, new BetterSqliteAtomicRunner(db)),
    sessionImport: undefined,
    sessionMetricsStore: new SqliteSessionMetricsStore(db),
    mcpOAuthStore: mcpServerStore,
    tokenStore,
    scheduleStore: new SqliteScheduleStore(db, new BetterSqliteAtomicRunner(db)),
    resolveModelProviderStore: () => modelProviderStore,
    resolveMcpServerStore: () => mcpServerStore,
    resolveSandboxProviderStore: () => sandboxProviderStore,
    resolveSkillStore: () => skillStore,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    agentStore,
    turnSkillsResolverStore: skillStore,
    destroyDb: () => db.destroy(),
    redis: undefined,
    serviceFoundryClient: undefined,
  };
}

/** Postgres stores + Redis for executor peering. */
async function createDistributedPersistence(options: {
  configuration: DistributedServerConfiguration;
  logger: Logger;
}): Promise<ServerPersistence<Transaction<PostgresDatabase>>> {
  const { configuration, logger } = options;
  const {
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: databasePoolMax,
    POSTGRES_STATEMENT_TIMEOUT_MS: statementTimeoutMs,
    POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: idleInTransactionSessionTimeoutMs,
    REDIS_URL: redisUrl,
    EXECUTOR_ID: executorId,
  } = configuration;

  const [{ createDb }, { migrateToLatest }, { connectRedis }, postgresStores] = await Promise.all([
    import('./db/postgres/client'),
    import('./db/migratePostgres'),
    import('./runtime/redis'),
    Promise.all([
      import('./db/postgres/session-store/PostgresSessionStore'),
      import('./db/postgres/session-metrics/PostgresSessionMetricsStore'),
      import('./db/postgres/model-provider-store/PostgresModelProviderStore'),
      import('./db/postgres/mcp-server-store/PostgresMcpServerStore'),
      import('./db/postgres/token-store/PostgresOAuthTokenStore'),
      import('./db/postgres/skill-store/PostgresSkillStore'),
      import('./db/postgres/sandbox-provider-store/PostgresSandboxProviderStore'),
      import('./db/postgres/agent-store/PostgresAgentStore'),
      import('./db/postgres/schedule-store/PostgresScheduleStore'),
    ]),
  ]);
  const [
    { PostgresSessionStore },
    { PostgresSessionMetricsStore },
    { PostgresModelProviderStore },
    { PostgresMcpServerStore },
    { PostgresOAuthTokenStore },
    { PostgresSkillStore },
    { PostgresSandboxProviderStore },
    { PostgresAgentStore },
    { PostgresScheduleStore },
  ] = postgresStores;

  const db = createDb({
    connectionString: databaseUrl,
    poolMax: databasePoolMax,
    statementTimeoutMs,
    idleInTransactionSessionTimeoutMs,
  });
  await migrateToLatest(db);
  logger.info('Distributed mode: postgres');
  logger.info(`Executor id: ${executorId}`);
  const serviceFoundryClient = createServiceFoundryServerClient(logger);
  const tokenStore = new PostgresOAuthTokenStore(db);
  const modelProviderStore = new PostgresModelProviderStore(db);
  const mcpServerStore = new PostgresMcpServerStore(db);
  const mcpServerWithAuthStore = new McpServerWithAuthStore({
    store: mcpServerStore,
    tokenStore,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
  });
  const sandboxProviderStore = new PostgresSandboxProviderStore(db);
  const skillStore = new PostgresSkillStore(db);
  const agentStore = new PostgresAgentStore(db);
  const turnSkillsResolverStore = buildTurnSkillsResolverStore({
    persistenceStore: skillStore,
    client: serviceFoundryClient,
  });
  const resolveModelProviderStore = buildResolveModelProviderStore({
    persistenceStore: modelProviderStore,
    client: serviceFoundryClient,
    logger,
  });
  const resolveMcpServerStore = buildResolveMcpServerStore({
    persistenceStore: mcpServerStore,
    tokenStore,
    client: serviceFoundryClient,
    logger,
  });
  const resolveAgentStore = buildResolveAgentStore({
    persistenceStore: agentStore,
    db,
    client: serviceFoundryClient,
  });
  const resolveImportAgentStore = (
    serviceFoundryServerHeaders: Record<string, string>,
  ): IAgentStore<Transaction<PostgresDatabase>> => {
    const client = createServiceFoundryServerClient(logger, serviceFoundryServerHeaders);
    if (client === undefined) {
      return agentStore;
    }
    return new TrueFoundryAgentStore({
      inner: agentStore,
      client,
      context: {
        tenant_id: 'system',
        subject: { id: 'tfy-system', type: 'serviceaccount', display_name: 'tfy-system' },
        roles: [],
        user_credential: client.apiKey,
      },
      db,
    });
  };
  const resolveSandboxProviderStore = buildResolveSandboxProviderStore({
    persistenceStore: sandboxProviderStore,
  });
  const resolveSkillStore = buildResolveSkillStore({
    persistenceStore: skillStore,
    client: serviceFoundryClient,
  });
  const sessionStore = new PostgresSessionStore(db);
  return {
    withTransaction: callback => db.transaction().execute(callback),
    sessionStore,
    sessionImport: sessionStore,
    sessionMetricsStore: new PostgresSessionMetricsStore(db),
    mcpOAuthStore: mcpServerWithAuthStore,
    tokenStore,
    scheduleStore: new PostgresScheduleStore(db),
    resolveModelProviderStore,
    resolveMcpServerStore,
    resolveSandboxProviderStore,
    resolveSkillStore,
    resolveAgentStore,
    resolveImportAgentStore,
    agentStore,
    turnSkillsResolverStore,
    destroyDb: () => db.destroy(),
    redis: await connectRedis({ url: redisUrl, logger }),
    serviceFoundryClient,
  };
}

/** Keeps `TTransaction` concrete when wiring a single persistence topology into the app. */
async function createServerRuntime<TTransaction>(
  persistence: ServerPersistence<TTransaction>,
  logger: Logger,
  sandboxIntegration: SandboxIntegration,
) {
  const {
    withTransaction,
    sessionStore,
    sessionMetricsStore,
    tokenStore,
    scheduleStore,
    mcpOAuthStore,
    resolveImportAgentStore,
    agentStore,
    turnSkillsResolverStore,
    destroyDb,
    redis,
    serviceFoundryClient,
  } = persistence;

  const activeTurns = new ActiveTurnRegistry();
  const requestReplyRouter = new RequestReplyRouter();
  const eventSubscriptions = new EventSubscriptionRegistry<TurnStreamingEvent>(redis);
  const sessions = new Sessions({ sessionStore });

  const oidc = isOidcConfigured(configuration) ? configuration.OIDC : undefined;
  if (oidc) {
    logger.info('Auth is enabled', { issuer: oidc.OIDC_ISSUER_URL });
  } else {
    logger.warn('Auth is disabled; browser login is off');
  }
  const oidcClient = await initOidc(oidc);

  let authenticator;
  let authorizer: Authorizer;
  const mode = getTrueForgeAuthMode(configuration);
  if (mode === TrueForgeAuthMode.TrueFoundry) {
    if (serviceFoundryClient === undefined) {
      throw new Error('TrueFoundry mode requires TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL');
    }
    authenticator = createAuthenticator({
      mode: TrueForgeAuthMode.TrueFoundry,
      serviceFoundryClient,
    });
    authorizer = new TrueFoundryAuthorizer(serviceFoundryClient);
  } else if (mode === TrueForgeAuthMode.Oidc) {
    authenticator = createAuthenticator({ mode: TrueForgeAuthMode.Oidc });
    authorizer = new TrueForgeAuthorizer();
  } else {
    authenticator = createAuthenticator({ mode: TrueForgeAuthMode.Standalone });
    authorizer = new TrueForgeAuthorizer();
  }

  // Standalone owns the control loops in-process; they hand off via HTTP loopback
  // (same transport as the dedicated controller in distributed mode).
  const controller = configuration.STANDALONE
    ? createController({
        scheduleStore,
        withTransaction,
        logger,
        serverUrl: configuration.SERVER_URL,
        apiKey: configuration.TRUEFORGE_API_KEY,
        tls: { enabled: configuration.TRUEFORGE_MTLS_ENABLED, dir: configuration.TRUEFORGE_MTLS_CERTS_DIR },
      })
    : undefined;

  // Hono handlers get Context; persistence resolvers take RequestContext.
  const resolveModelProviderStore = (c: Context, runAsAgent?: AgentRecord) =>
    persistence.resolveModelProviderStore(resolveRequestContext(c), runAsAgent);
  const resolveMcpServerStore = (c?: Context, runAsAgent?: AgentRecord) => {
    if (c === undefined) {
      return mcpOAuthStore;
    }
    const rawPerServerHeaders = c.req.header(X_TFG_MCP_HEADERS);
    return persistence.resolveMcpServerStore(
      resolveRequestContext(c),
      runAsAgent,
      rawPerServerHeaders === undefined ? undefined : parsePerServerMcpHeaders(rawPerServerHeaders),
    );
  };
  const resolveAgentStore = (c: Context) => persistence.resolveAgentStore(resolveRequestContext(c));
  const resolveSandboxProviderStore = (c: Context) => persistence.resolveSandboxProviderStore(resolveRequestContext(c));
  const resolveSkillStore = (c: Context) => persistence.resolveSkillStore(resolveRequestContext(c));
  const app = createServerApp({
    modelCatalog: ModelCatalog.load(),
    mcpCatalog: McpCatalog.load(),
    skillCatalog: SkillCatalog.load(),
    sandboxCatalog: SandboxCatalog.load(),
    resolveModelProviderStore,
    resolveMcpServerStore,
    resolveAgentStore,
    resolveImportAgentStore,
    resolveSandboxProviderStore,
    sandboxIntegration,
    clientCertificateMiddleware:
      !configuration.STANDALONE && configuration.TRUEFORGE_MTLS_ENABLED
        ? createClientCertificateMiddleware(logger)
        : undefined,
    resolveSkillStore,
    withTransaction,
    tokenStore,
    scheduleStore,
    agentStore,
    turnSkillsResolverStore,
    sessionStore,
    sessionImport: persistence.sessionImport,
    sessionMetricsStore,
    sessions,
    activeTurns,
    redis,
    requestReplyRouter,
    eventSubscriptions,
    logger,
    oidcClient,
    authenticator,
    authorizer,
  });

  return { activeTurns, app, controller, destroyDb, redis, requestReplyRouter };
}

try {
  const logger = createServerLogger({
    level: configuration.LOG_LEVEL,
    standalone: configuration.STANDALONE,
    version: PACKAGE_VERSION,
  });

  let localSandboxSupport: LocalSandboxSupportResult | undefined;
  if (configuration.STANDALONE) {
    printStandaloneStartupBanner({ version: PACKAGE_VERSION, color: shouldColorize() });
    await prepareCodeModeSocketParent({ path: CODE_MODE_SOCKET_PARENT, logger });
    await ensureLocalSandboxRootParent(LOCAL_SANDBOX_ROOT_PARENT);
    const { LocalSandboxProvider } = await import('./sandbox/local/provider/LocalSandboxProvider');
    const support = await LocalSandboxProvider.isSupported({
      codeModeSocketParentPath: CODE_MODE_SOCKET_PARENT,
    });
    localSandboxSupport = support;
    if (support.supported) {
      logger.info('Local sandbox fallback is available', {
        platform: support.platform,
        shell: support.shell,
        python: support.python,
      });
    } else {
      logger.warn('Local sandbox fallback is unavailable', {
        reason: support.reason,
        ...(support.platform === undefined ? {} : { platform: support.platform }),
        ...(support.attempts === undefined ? {} : { attempts: support.attempts }),
      });
    }
  } else {
    logger.info('TrueForge starting', { mode: 'distributed' });
  }

  const sandboxIntegration = createNodeSandboxIntegration({ localSupport: localSandboxSupport });
  const { activeTurns, app, controller, destroyDb, redis, requestReplyRouter } = configuration.STANDALONE
    ? await createServerRuntime(
        await createStandalonePersistence({ sqlitePath: SQLITE_PATH, logger }),
        logger,
        sandboxIntegration,
      )
    : await createServerRuntime(
        await createDistributedPersistence({ configuration, logger }),
        logger,
        sandboxIntegration,
      );

  if (
    mountFrontend(app, {
      dir: FRONTEND_DIR,
      uiBasePath: getPublicUiBasePath(),
    })
  ) {
    logger.info(`Serving frontend from ${FRONTEND_DIR}`);
  } else {
    logger.warn(
      `No frontend build at ${FRONTEND_DIR}: serving the API only. ` +
        'Run `pnpm --filter frontend build` (and copy via build:frontend-assets) to serve the UI, or `pnpm standalone:dev` / `pnpm dev` for Vite.',
    );
  }

  // After createServerApp so every request-reply route is registered before
  // the executor starts consuming messages. The executor needs a dedicated
  // subscriber connection (a subscribed client cannot issue normal commands);
  // this process owns its lifecycle. Connect before init() so init() awaits
  // the initial subscribe + heartbeat — the replica is reachable for peering
  // before the HTTP server starts.
  let requestReplySubscriber: RedisClientType | undefined;
  let requestReplyExecutor: RequestReplyExecutor | undefined;
  if (redis) {
    requestReplySubscriber = redis.duplicate();
    requestReplySubscriber.on('error', (error: Error) => {
      logger.error('[RedisSubscriber] Client error', extractErrorLogFields(error));
    });
    await requestReplySubscriber.connect();
    requestReplyExecutor = new RequestReplyExecutor({
      executorId: configuration.EXECUTOR_ID,
      redis,
      subscriberClient: requestReplySubscriber,
      requestHandler: requestReplyRouter.createRequestHandler(),
      logger,
      options: {
        heartbeatIntervalMs: configuration.REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS,
        replyTtlMs: configuration.REDIS_REQUEST_REPLY_REPLY_TTL_MS,
      },
    });
    await requestReplyExecutor.init();
  }

  const tlsServe = serverTlsServeOptions({
    enabled: !configuration.STANDALONE && configuration.TRUEFORGE_MTLS_ENABLED,
    dir: configuration.TRUEFORGE_MTLS_CERTS_DIR,
  });
  const server = serve(
    {
      fetch: app.fetch,
      port: configuration.PORT,
      hostname: configuration.HOST,
      ...(tlsServe ?? {}),
    },
    info => {
      const scheme = tlsServe !== undefined ? 'https' : 'http';
      logger.info(
        `Agent server listening on ${scheme}://${configuration.HOST}:${String(info.port)} (docs at /api/v1/docs)`,
      );
      // The controller calls this server over HTTP(S).
      controller?.start();
    },
  );

  server.on('error', (error: unknown) => {
    console.error('Failed to start server:', error instanceof Error ? error.message : error);
    process.exit(1);
  });

  // Graceful drain is the safe default for built and direct execution.
  // Development watch mode opts out so tsx can restart without waiting for a drain.
  if (configuration.NODE_ENV !== 'development') {
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info(`Received ${signal}, draining connections before shutdown`);

      // Arm at the start of each shutdown; unref so this timer alone cannot keep the process alive.
      setTimeout(() => {
        logger.warn(`Drain timed out after ${String(configuration.GRACEFUL_TIMEOUT_SECONDS)}s, exiting`);
        process.exit(1);
      }, configuration.GRACEFUL_TIMEOUT_SECONDS * 1000).unref();

      const closed = new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      });

      // Stop the control loops before draining; anything they already started drains
      // with every other turn below.
      await controller?.stop();

      // Sets the registry's shutdown reason immediately so late track() (in-flight create-turn still
      // inside session.createTurn) aborts as Abandoned; then drains the registry. await
      // closed covers the gap where the registry is empty before that late track().
      await activeTurns.shutdownAndWait(CancellationReason.Abandoned);
      await closed;
      // Stop serving peer requests (waits for in-flight replies), then close
      // the clients this process owns: the subscriber duplicate and the primary.
      await requestReplyExecutor?.drain();
      await requestReplySubscriber?.close().catch((error: unknown) => {
        logger.warn('[Redis] Error closing subscriber client during shutdown', extractErrorLogFields(error));
      });
      await redis?.close().catch((error: unknown) => {
        logger.warn('[Redis] Error closing client during shutdown', extractErrorLogFields(error));
      });
      if (configuration.STANDALONE) {
        await removeCodeModeSocketParent(CODE_MODE_SOCKET_PARENT).catch((error: unknown) => {
          logger.warn('Error removing Code Mode socket parent during shutdown', extractErrorLogFields(error));
        });
      }
      await destroyDb();
      process.exit(0);
    };
    process.on('SIGTERM', signal => {
      void shutdown(signal);
    });
    process.on('SIGINT', signal => {
      void shutdown(signal);
    });
  }
} catch (error) {
  console.error('Failed to start server:', error instanceof Error ? error.message : error);
  process.exit(1);
}
