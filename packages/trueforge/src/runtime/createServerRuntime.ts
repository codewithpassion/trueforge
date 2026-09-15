import { Sessions, type ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context, MiddlewareHandler } from 'hono';
import { createServerApp } from '../app';
import type { Authenticator } from '../auth/authenticator';
import type { Authorizer } from '../auth/authorizer';
import { resolveRequestContext, type RequestContext } from '../auth/identity';
import { initOidc } from '../auth/oidc';
import { McpCatalog } from '../catalog/McpCatalog';
import { ModelCatalog } from '../catalog/ModelCatalog';
import { SandboxCatalog } from '../catalog/SandboxCatalog';
import { SkillCatalog } from '../catalog/SkillCatalog';
import configuration, { isOidcConfigured } from '../config';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { SessionImport } from '../db/sessionImport';
import type { ISessionMetricsStore } from '../db/sessionMetricsStore';
import type { ISkillStore } from '../db/skillStore';
import type { WithTransaction } from '../db/transaction';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import type { SandboxIntegration } from '../sandbox/integration';
import {
  parsePerServerMcpHeaders,
  X_TFG_MCP_HEADERS,
  type PerServerMcpHeaders,
} from '../truefoundry/perServerMcpHeaders';
import type { TurnExecutor } from './turnExecutor';

/** Persistence wired for the selected topology. */
export interface ServerPersistence<TTransaction> {
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
}

/**
 * Builds the HTTP app over one persistence topology. Entry points pick the auth pair, turn executor,
 * and transport middleware, and own the process or isolate lifecycle.
 */
export async function createServerRuntime<TTransaction>(options: {
  persistence: ServerPersistence<TTransaction>;
  logger: Logger;
  sandboxIntegration: SandboxIntegration | undefined;
  clientCertificateMiddleware: MiddlewareHandler | undefined;
  authenticator: Authenticator;
  authorizer: Authorizer;
  turnExecutor: TurnExecutor;
}) {
  const { persistence, logger } = options;
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
  } = persistence;

  const sessions = new Sessions({ sessionStore });

  const oidc = isOidcConfigured(configuration) ? configuration.OIDC : undefined;
  if (oidc) {
    logger.info('Auth is enabled', { issuer: oidc.OIDC_ISSUER_URL });
  } else {
    logger.warn('Auth is disabled; browser login is off');
  }
  const oidcClient = await initOidc(oidc);

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
  return createServerApp({
    modelCatalog: ModelCatalog.load(),
    mcpCatalog: McpCatalog.load(),
    skillCatalog: SkillCatalog.load(),
    sandboxCatalog: SandboxCatalog.load(),
    resolveModelProviderStore,
    resolveMcpServerStore,
    resolveAgentStore,
    resolveImportAgentStore,
    resolveSandboxProviderStore,
    sandboxIntegration: options.sandboxIntegration,
    clientCertificateMiddleware: options.clientCertificateMiddleware,
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
    turnExecutor: options.turnExecutor,
    logger,
    oidcClient,
    authenticator: options.authenticator,
    authorizer: options.authorizer,
  });
}
