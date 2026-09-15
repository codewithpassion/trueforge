import type { Kysely } from 'kysely';
import { TrueForgeAuthorizer } from '../auth/authorizer';
import { OidcAuthenticator } from '../auth/oidcAuthenticator';
import configuration from '../config';
import { createD1Persistence } from '../db/d1/persistence';
import type { Database } from '../db/sqlite/types';
import { createServerRuntime, type ServerPersistence } from '../runtime/createServerRuntime';
import type { Env } from './env';
import { createConsoleLogger } from './logger';
import { assertWorkersRuntime } from './runtimeGuard';
import { WorkersTurnExecutor } from './workersTurnExecutor';

export interface WorkersRuntimeDeps {
  persistence: ServerPersistence<Kysely<Database>>;
  turnExecutor: WorkersTurnExecutor;
}

/** D1 persistence and the session Durable Object executor, shared by the HTTP app and the scheduler. */
export function createWorkersRuntimeDeps(env: Env): WorkersRuntimeDeps {
  assertWorkersRuntime(configuration);
  const d1 = createD1Persistence({ database: env.DB, mcpClientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME });
  return {
    persistence: {
      withTransaction: d1.withTransaction,
      sessionStore: d1.sessionStore,
      sessionImport: undefined,
      sessionMetricsStore: d1.sessionMetricsStore,
      tokenStore: d1.tokenStore,
      scheduleStore: d1.scheduleStore,
      mcpOAuthStore: d1.mcpServerStore,
      resolveModelProviderStore: () => d1.modelProviderStore,
      resolveMcpServerStore: () => d1.mcpServerStore,
      resolveSandboxProviderStore: () => d1.sandboxProviderStore,
      resolveSkillStore: () => d1.skillStore,
      resolveAgentStore: () => d1.agentStore,
      resolveImportAgentStore: () => d1.agentStore,
      agentStore: d1.agentStore,
      turnSkillsResolverStore: d1.skillStore,
    },
    turnExecutor: new WorkersTurnExecutor({ namespace: env.SESSION_DO, sessionStore: d1.sessionStore }),
  };
}

/** The Hono app over D1 stores and session Durable Objects. Build once per isolate, on first request. */
export async function createWorkersServerRuntime(env: Env) {
  const { persistence, turnExecutor } = createWorkersRuntimeDeps(env);
  const logger = createConsoleLogger({ level: configuration.LOG_LEVEL, bindings: { component: 'worker' } });
  return createServerRuntime({
    persistence,
    logger,
    sandboxIntegration: undefined,
    clientCertificateMiddleware: undefined,
    authenticator: new OidcAuthenticator(),
    authorizer: new TrueForgeAuthorizer(),
    turnExecutor,
  });
}
