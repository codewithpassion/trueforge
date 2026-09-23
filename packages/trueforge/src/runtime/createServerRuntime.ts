import { Sessions, type IFileStore, type ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context, MiddlewareHandler } from 'hono';
import { createServerApp } from '../app';
import type { Authenticator } from '../auth/authenticator';
import type { Authorizer } from '../auth/authorizer';
import { requestContextFromCreatedBySubject, resolveRequestContext, type RequestContext } from '../auth/identity';
import { initOidc } from '../auth/oidc';
import { McpCatalog } from '../catalog/McpCatalog';
import { ModelCatalog } from '../catalog/ModelCatalog';
import { SandboxCatalog } from '../catalog/SandboxCatalog';
import { SkillCatalog } from '../catalog/SkillCatalog';
import type { ComputersService } from '../computers/service';
import { createHumanTakeoverService } from '../computers/takeover';
import configuration, { isOidcConfigured, isTrueFoundryModeEnabled } from '../config';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IIntegrationStore } from '../db/integrationStore';
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
import { InlineMcpServerStore } from '../truefoundry/InlineMcpServerStore';
import { parseInlineMcpServers, parseInlineSkills, X_TFG_MCP, X_TFG_SKILLS } from '../truefoundry/inlineResources';
import { InlineSkillStore } from '../truefoundry/InlineSkillStore';
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
  fileStore: IFileStore;
  /** Postgres only; undefined disables the session import routes. */
  sessionImport: SessionImport | undefined;
  sessionMetricsStore: ISessionMetricsStore;
  tokenStore: IOAuthTokenStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  integrationStore: IIntegrationStore<TTransaction>;
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
  /** Undefined when this runtime cannot reach a machine's relay. */
  computers: ComputersService | undefined;
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
    integrationStore,
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
    const store = persistence.resolveMcpServerStore(
      resolveRequestContext(c),
      runAsAgent,
      rawPerServerHeaders === undefined ? undefined : parsePerServerMcpHeaders(rawPerServerHeaders),
    );
    if (!isTrueFoundryModeEnabled(configuration)) {
      return store;
    }
    const rawInline = c.req.header(X_TFG_MCP);
    if (rawInline === undefined) {
      return store;
    }
    return new InlineMcpServerStore({ inner: store, inline: parseInlineMcpServers(rawInline) });
  };
  const resolveAgentStore = (c: Context) => persistence.resolveAgentStore(resolveRequestContext(c));
  const resolveSandboxProviderStore = (c: Context) => persistence.resolveSandboxProviderStore(resolveRequestContext(c));
  const resolveSkillStore = (c: Context) => {
    const store = persistence.resolveSkillStore(resolveRequestContext(c));
    if (!isTrueFoundryModeEnabled(configuration)) {
      return store;
    }
    const rawInline = c.req.header(X_TFG_SKILLS);
    if (rawInline === undefined) {
      return store;
    }
    return new InlineSkillStore({ inner: store, inline: parseInlineSkills(rawInline) });
  };
  const computers = options.computers;
  const humanTakeovers =
    computers === undefined
      ? undefined
      : createHumanTakeoverService({
          computers,
          sessions,
          agentStore,
          turnExecutor: options.turnExecutor,
          // Like a scheduled run: no live caller, so stores resolve as the session's creator.
          resolveTurnStores: ({ session, agent }) => {
            const requestContext = requestContextFromCreatedBySubject({
              tenant_id: session.tenant_id,
              created_by_subject: session.record.created_by_subject,
            });
            return {
              agentStore,
              modelProviderStore: persistence.resolveModelProviderStore(requestContext, agent),
              mcpServerStore: persistence.resolveMcpServerStore(requestContext, agent),
              sandboxProviderStore: persistence.resolveSandboxProviderStore(requestContext),
              skillStore: turnSkillsResolverStore,
            };
          },
          logger,
        });
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
    computers,
    humanTakeovers,
    clientCertificateMiddleware: options.clientCertificateMiddleware,
    resolveSkillStore,
    withTransaction,
    tokenStore,
    scheduleStore,
    integrationStore,
    agentStore,
    turnSkillsResolverStore,
    sessionStore,
    fileStore: persistence.fileStore,
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
