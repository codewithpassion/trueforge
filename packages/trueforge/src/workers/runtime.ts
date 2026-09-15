import { TrueForgeAuthorizer } from '../auth/authorizer';
import { OidcAuthenticator } from '../auth/oidcAuthenticator';
import configuration from '../config';
import { createD1Persistence } from '../db/d1/persistence';
import { createServerRuntime } from '../runtime/createServerRuntime';
import type { Env } from './env';
import { createConsoleLogger } from './logger';
import { assertWorkersRuntime } from './runtimeGuard';
import { WorkersTurnExecutor } from './workersTurnExecutor';

/** The Hono app over D1 stores and session Durable Objects. Build once per isolate, on first request. */
export async function createWorkersServerRuntime(env: Env) {
  assertWorkersRuntime(configuration);
  const logger = createConsoleLogger({ level: configuration.LOG_LEVEL, bindings: { component: 'worker' } });
  const d1 = createD1Persistence({ database: env.DB, mcpClientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME });
  return createServerRuntime({
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
    logger,
    sandboxIntegration: undefined,
    clientCertificateMiddleware: undefined,
    authenticator: new OidcAuthenticator(),
    authorizer: new TrueForgeAuthorizer(),
    turnExecutor: new WorkersTurnExecutor({ namespace: env.SESSION_DO, sessionStore: d1.sessionStore }),
  });
}
