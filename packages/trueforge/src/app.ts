/** The API: resource routers, the OpenAPI document and Swagger UI, all under /api/v1. */
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { IFileStore, ISessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Configuration } from 'openid-client';
import { createAgentImportRouter } from './apis/agentImport';
import { createAgentsRouter } from './apis/agents';
import { createAuthRouter } from './apis/auth';
import { createCapabilitiesRouter } from './apis/capabilities';
import { createCatalogRouter } from './apis/catalog';
import {
  COMPUTERS_UNSUPPORTED,
  createComputerMachineRouter,
  createComputersRouter,
  registerComputerConnectRoute,
} from './apis/computers';
import { createIntegrationEventsRouter } from './apis/integrationEvents';
import { createIntegrationsRouter } from './apis/integrations';
import { createMcpOAuthRouter } from './apis/mcpOAuth';
import { createMcpServersRouter } from './apis/mcpServers';
import { createModelsRouter } from './apis/models';
import { createPermissionsRouter } from './apis/permissions';
import { createScheduleExecutionRouter, createSchedulesRouter } from './apis/schedules';
import { createInternalMetricsRouter } from './apis/sessionMetrics';
import { createInternalSessionsRouter, createSessionsRouter } from './apis/sessions';
import { createSettingsRouter } from './apis/settings';
import { createAvailableSkillsRouter, type ResolveSkillStore } from './apis/skills';
import { createTurnsRouter } from './apis/turns';
import type { Authenticator } from './auth/authenticator';
import type { Authorizer } from './auth/authorizer';
import { resolveRequestContext } from './auth/identity';
import {
  createAdminAuthMiddleware,
  createApiKeyAuthMiddleware,
  createAuthMiddleware,
  truefoundryAdminMiddleware,
} from './auth/middleware';
import type { McpCatalog } from './catalog/McpCatalog';
import type { ModelCatalog } from './catalog/ModelCatalog';
import type { SandboxCatalog } from './catalog/SandboxCatalog';
import type { SkillCatalog } from './catalog/SkillCatalog';
import {
  INSTALL_SCRIPT_NO_BASE_URL,
  INSTALL_SCRIPT_UNCONFIGURED,
  renderInstallScript,
} from './computers/installScript';
import type { ComputersService } from './computers/service';
import configuration, {
  getPublicBaseUrl,
  getPublicBaseUrlOrUndefined,
  getPublicUiBasePath,
  getTrueForgeAuthMode,
  TrueForgeAuthMode,
} from './config';
import type { AgentRecord, IAgentStore } from './db/agentStore';
import type { IIntegrationStore } from './db/integrationStore';
import type { IMcpServerWithAuthStore } from './db/mcpServerStore';
import type { IModelProviderStore } from './db/modelProviderStore';
import type { ISandboxProviderStore } from './db/sandboxProviderStore';
import type { IScheduleStore } from './db/scheduleStore';
import type { SessionImport } from './db/sessionImport';
import type { ISessionMetricsStore } from './db/sessionMetricsStore';
import type { ISkillStore } from './db/skillStore';
import type { WithTransaction } from './db/transaction';
import { createIntegrationAdapters } from './integrations/registry';
import type { IOAuthTokenStore } from './mcp/auth/types';
import { PACKAGE_VERSION } from './packageVersion.gen';
import { OPENAPI_DOCUMENT_TAGS } from './routes/openapiTags';
import type { TurnExecutor } from './runtime/turnExecutor';
import type { SandboxIntegration } from './sandbox/integration';
import { InvalidCronError } from './schemas/schedule';
import { zodErrorResponse, zodValidationHook } from './zodErrorResponse';

const BEARER_AUTH_SCHEME = 'BearerAuth';

function withAuth(router: OpenAPIHono, middleware: MiddlewareHandler): OpenAPIHono {
  const shell = new OpenAPIHono();
  shell.use('*', middleware);
  shell.route('/', router);
  return shell;
}

function withAdminAuth(router: OpenAPIHono, middleware: MiddlewareHandler): OpenAPIHono {
  const shell = new OpenAPIHono();
  shell.use('*', middleware);
  shell.route('/', router);
  return shell;
}

/** One line per request: method, path, status, duration. Skips `/healthz` and `/assets/`. */
export function createAccessLogMiddleware(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const path = c.req.path;
    if (path === '/healthz' || path.startsWith('/assets/')) {
      return;
    }
    logger.info('request', {
      method: c.req.method,
      path,
      status: c.res.status,
      duration_ms: Math.round(performance.now() - started),
    });
  };
}

/** Hono bodyLimit wrapper that returns the API error envelope on 413. */
export function createRequestBodyLimitMiddleware(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: c =>
      c.json({ error: { message: `Request body exceeds the maximum size of ${String(maxSize)} bytes` } }, 413),
  });
}

export function createAppErrorHandler(params: { logger: Logger }): ErrorHandler {
  return (error, c) => {
    if (error instanceof z.ZodError) {
      return zodErrorResponse(c, error);
    }
    if (error instanceof InvalidCronError) {
      return c.json({ error: { message: error.message } }, 400);
    }
    if (error instanceof HTTPException) {
      if (error.status >= 500) {
        params.logger.error('Server API error', {
          status: error.status,
          ...extractErrorLogFields(error),
        });
      }
      return c.json({ error: { message: error.message } }, error.status);
    }
    params.logger.error('Unhandled error', extractErrorLogFields(error));
    return c.json({ error: { message: 'Internal server error' } }, 500);
  };
}

const openApiDocConfig = {
  openapi: '3.1.0',
  info: {
    title: 'TrueForge API',
    description:
      'HTTP API for the TrueForge agent server (`/api/v1`). Interactive docs are served at `/api/v1/docs` ' +
      '(OpenAPI JSON at `/api/v1/openapi.json`).\n\n' +
      '**Authentication:** Standalone auth accepts requests without credentials — middleware ' +
      'stamps a local default user. When OIDC or TrueFoundry auth is configured, protected routes require a valid ' +
      'cookie or `Authorization: Bearer` token. There is no built-in API-key scheme; ' +
      'pass custom headers only if your reverse proxy or IdP layer requires them.\n\n' +
      'Covers DB-backed sessions, the agent registry, settings catalogs, and model/MCP/skill/sandbox providers.',
    version: PACKAGE_VERSION,
  },
  tags: OPENAPI_DOCUMENT_TAGS,
};

/** Registers the Bearer ID-token scheme used by {@link buildOpenApiDocument}. */
export function registerOpenApiBearerAuth(app: OpenAPIHono): void {
  app.openAPIRegistry.registerComponent('securitySchemes', BEARER_AUTH_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Caller credential (`Authorization: Bearer <token>`). Required on protected routes when auth is enabled. ' +
      'Browser sessions may use the HttpOnly `id_token` or `accessToken` cookie instead.',
  });
}

/**
 * Single source for both the served document and the one the SDK is built from.
 * When `authEnabled`, advertises required Bearer auth on operations that inherit global security.
 * `serverUrl` is the public prefix for Try it out (e.g. `/custom/proxy/path`); omit for the SDK spec.
 */
export function buildOpenApiDocument(app: OpenAPIHono, options?: { authEnabled?: boolean; serverUrl?: string }) {
  const authEnabled = options?.authEnabled ?? false;
  if (authEnabled) {
    registerOpenApiBearerAuth(app);
  }
  const serverUrl = options?.serverUrl;
  return app.getOpenAPI31Document({
    ...openApiDocConfig,
    ...(authEnabled ? { security: [{ [BEARER_AUTH_SCHEME]: [] }] } : {}),
    ...(serverUrl !== undefined && serverUrl !== '' ? { servers: [{ url: serverUrl }] } : {}),
  });
}

function routeNotFound(c: Context) {
  return c.json({ error: { message: `Route not found: ${c.req.method} ${c.req.path}` } }, 404);
}

export interface ServerDeps<TTransaction> {
  modelCatalog: ModelCatalog;
  mcpCatalog: McpCatalog;
  skillCatalog: SkillCatalog;
  sandboxCatalog: SandboxCatalog;
  /** Per-request store: DB singleton, or a token-bound TrueFoundry store in TrueFoundry mode. */
  resolveModelProviderStore: (c: Context, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction>;
  /**
   * Per-request store: DB singleton, or a token-bound TrueFoundry store in TrueFoundry mode.
   * The unauthenticated OAuth callback has no context and gets the DB persistence store.
   */
  resolveMcpServerStore: (c?: Context, runAsAgent?: AgentRecord) => IMcpServerWithAuthStore<TTransaction>;
  /** Per-request store: DB singleton, or a token-bound TrueFoundry decorator in TrueFoundry mode. */
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  /** Import agents: store with SF client constructor assume-user headers (DB store when TrueFoundry mode is off). */
  resolveImportAgentStore: (serviceFoundryServerHeaders: Record<string, string>) => IAgentStore<TTransaction>;
  /**
   * Per-request store: DB singleton, or the env-backed shared store in TrueFoundry mode
   * (`TRUEFOUNDRY_SANDBOX_*` + static SETTINGS JSON).
   */
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  /** Undefined when this runtime cannot run sandboxes; sandbox features then report unavailable. */
  sandboxIntegration: SandboxIntegration | undefined;
  /**
   * Undefined when this runtime cannot reach a machine's relay. The computer routes then answer
   * 404 and `GET /capabilities` reports computers off, which is the Node build until phase 8c.
   */
  computers: ComputersService | undefined;
  /** Rejects requests without a verified client certificate; set only when mTLS is on. */
  clientCertificateMiddleware: MiddlewareHandler | undefined;
  /** Per-request store: DB git skills, or TrueFoundry registry catalog in TrueFoundry mode. */
  resolveSkillStore: ResolveSkillStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  integrationStore: IIntegrationStore<TTransaction>;
  sessionStore: ISessionStore;
  fileStore: IFileStore;
  /** Historical session backfill; undefined makes the import session routes fail with 500. */
  sessionImport: SessionImport | undefined;
  sessionMetricsStore: ISessionMetricsStore;
  /** Persistence agent store (schedule runs resolve the bound agent without an HTTP caller). */
  agentStore: IAgentStore<TTransaction>;
  /** Resolve turn skills - persistence store or TrueFoundry resolve with Service API key (schedule runs do have any caller token). */
  turnSkillsResolverStore: Pick<ISkillStore<TTransaction>, 'resolveTurnSkills'>;
  sessions: Sessions;
  /** Runs, streams, resumes, and cancels turns. */
  turnExecutor: TurnExecutor;
  logger: Logger;
  /** Discovered openid-client configuration; undefined when browser login is disabled. */
  oidcClient: Configuration | undefined;
  /** Startup-selected authenticator; middleware is built from this once per app. */
  authenticator: Authenticator;
  /** Startup-selected agent authorization policy. */
  authorizer: Authorizer;
}

export function createServerApp<TTransaction>(deps: ServerDeps<TTransaction>) {
  const app = new OpenAPIHono({ defaultHook: zodValidationHook });
  const authMiddleware = createAuthMiddleware(deps.authenticator);
  const adminAuthMiddleware = createAdminAuthMiddleware(deps.authenticator);
  const authEnabled = getTrueForgeAuthMode() !== TrueForgeAuthMode.Standalone;
  const scheduleTurnDeps = {
    scheduleStore: deps.scheduleStore,
    sessions: deps.sessions,
    agentStore: deps.agentStore,
    turnExecutor: deps.turnExecutor,
    resolveModelProviderStore: deps.resolveModelProviderStore,
    resolveMcpServerStore: deps.resolveMcpServerStore,
    resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
    turnSkillsResolverStore: deps.turnSkillsResolverStore,
  };

  if (configuration.ACCESS_LOGS) {
    app.use('*', createAccessLogMiddleware(deps.logger));
  }
  if (deps.clientCertificateMiddleware !== undefined) {
    app.use('*', deps.clientCertificateMiddleware);
  }
  app.use('*', createRequestBodyLimitMiddleware(configuration.MAX_REQUEST_BODY_BYTES));

  app.get('/healthz', c => c.json({ status: 'ok', version: PACKAGE_VERSION }));

  app.get('/install.sh', c => {
    // Nothing to install against on a runtime that cannot hold a machine's socket.
    if (deps.computers === undefined) {
      return c.json({ error: { message: COMPUTERS_UNSUPPORTED } }, 404);
    }
    if (configuration.REMOTE_COMPUTER_RELEASE_BASE_URL === '') {
      return c.json({ error: { message: INSTALL_SCRIPT_UNCONFIGURED } }, 503);
    }
    // The script has to point back at this server, and `getPublicBaseUrl` throws when it cannot
    // say where that is. A misconfigured deploy is not an internal error to the person reading it.
    if (getPublicBaseUrlOrUndefined() === undefined) {
      return c.json({ error: { message: INSTALL_SCRIPT_NO_BASE_URL } }, 503);
    }
    return c.body(
      renderInstallScript({
        baseUrl: getPublicBaseUrl(),
        releaseBaseUrl: configuration.REMOTE_COMPUTER_RELEASE_BASE_URL,
      }),
      200,
      { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' },
    );
  });

  // The machine's own routes carry a credential of their own, so they are mounted without an auth
  // shell — and before the admin mount, whose `use('*')` would otherwise swallow them.
  registerComputerConnectRoute({
    app,
    path: '/api/v1/computers/connect',
    computers: deps.computers,
    logger: deps.logger,
  });
  app.route('/api/v1/computers', createComputerMachineRouter({ computers: deps.computers, logger: deps.logger }));
  app.route(
    '/api/v1/computers',
    withAdminAuth(
      createComputersRouter({
        computers: deps.computers,
        resolveRequestContext,
        resolveAgentStore: deps.resolveAgentStore,
        publicBaseUrl: () => getPublicBaseUrl(),
        releaseBaseUrl: configuration.REMOTE_COMPUTER_RELEASE_BASE_URL,
        dockerImage: configuration.REMOTE_COMPUTER_DOCKER_IMAGE,
        logger: deps.logger,
      }),
      adminAuthMiddleware,
    ),
  );

  app.route(
    '/api/v1/auth',
    createAuthRouter({
      oidcClient: deps.oidcClient,
      logger: deps.logger,
      authMiddleware,
    }),
  );
  app.route(
    '/api/v1/capabilities',
    withAuth(
      createCapabilitiesRouter({
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        sandboxIntegration: deps.sandboxIntegration,
        computers: deps.computers,
        withTransaction: deps.withTransaction,
        logger: deps.logger,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/models',
    withAuth(
      createModelsRouter({
        resolveModelProviderStore: deps.resolveModelProviderStore,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/catalogs',
    withAuth(
      createCatalogRouter({
        modelCatalog: deps.modelCatalog,
        mcpCatalog: deps.mcpCatalog,
        skillCatalog: deps.skillCatalog,
        sandboxCatalog: deps.sandboxCatalog,
        sandboxIntegration: deps.sandboxIntegration,
      }),
      authMiddleware,
    ),
  );
  // Public MCP OAuth callbacks (local DCR + TrueFoundry/SFY) must be registered before the gated
  // `/mcp-servers` mount so `withAuth` cannot intercept IdP redirects to `/api/v1/mcp-servers/oauth/*`.
  app.route(
    '/api/v1/mcp-servers/oauth',
    createMcpOAuthRouter({
      tokenStore: deps.tokenStore,
      mcpServerStore: deps.resolveMcpServerStore(),
      logger: deps.logger,
    }),
  );
  // Channel ingress carries the channel's own signature instead of a TrueForge credential, so
  // neither mount below has an auth shell: the CRUD router binds auth to its own paths only.
  app.route(
    '/api/v1/integrations',
    createIntegrationsRouter({
      resolveIntegrationStore: () => deps.integrationStore,
      resolveAgentStore: deps.resolveAgentStore,
      withTransaction: deps.withTransaction,
      resolveRequestContext,
      authorizer: deps.authorizer,
      authMiddleware,
      publicBaseUrl: () => getPublicBaseUrl(),
      logger: deps.logger,
    }),
  );
  app.route(
    '/api/v1/integrations',
    createIntegrationEventsRouter({
      integrationStore: deps.integrationStore,
      adapters: createIntegrationAdapters(),
      sessions: deps.sessions,
      turnExecutor: deps.turnExecutor,
      resolveModelProviderStore: deps.resolveModelProviderStore,
      resolveMcpServerStore: deps.resolveMcpServerStore,
      resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
      agentStore: deps.agentStore,
      scheduleStore: deps.scheduleStore,
      turnSkillsResolverStore: deps.turnSkillsResolverStore,
      logger: deps.logger,
    }),
  );
  app.route(
    '/api/v1/mcp-servers',
    withAuth(
      createMcpServersRouter({
        resolveMcpServerStore: deps.resolveMcpServerStore,
        withTransaction: deps.withTransaction,
        logger: deps.logger,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/skills',
    withAuth(
      createAvailableSkillsRouter({
        resolveSkillStore: deps.resolveSkillStore,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/agents',
    withAuth(
      createAgentsRouter({
        resolveAgentStore: deps.resolveAgentStore,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        sandboxIntegration: deps.sandboxIntegration,
        computers: deps.computers,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
        authorizer: deps.authorizer,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  // The HTTP loopback controller is Node-only; Workers have no service API key to accept.
  if (configuration.RUNTIME !== 'workers') {
    app.route(
      '/api/internal/schedules',
      withAuth(
        createScheduleExecutionRouter(scheduleTurnDeps),
        createApiKeyAuthMiddleware(configuration.TRUEFORGE_API_KEY),
      ),
    );
  }
  app.route(
    '/api/v1/schedules',
    withAuth(
      createSchedulesRouter({
        ...scheduleTurnDeps,
        resolveAgentStore: deps.resolveAgentStore,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/settings',
    withAdminAuth(
      createSettingsRouter({
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        sandboxIntegration: deps.sandboxIntegration,
        withTransaction: deps.withTransaction,
        logger: deps.logger,
        resolveRequestContext,
      }),
      adminAuthMiddleware,
    ),
  );
  app.route(
    '/api/internal/import',
    withAuth(
      createAgentImportRouter({
        sessionImport: deps.sessionImport,
        resolveImportAgentStore: deps.resolveImportAgentStore,
      }),
      truefoundryAdminMiddleware,
    ),
  );
  app.route(
    '/api/internal/sessions',
    withAuth(
      createInternalSessionsRouter({
        sessions: deps.sessions,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveAgentStore: deps.resolveAgentStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        sandboxIntegration: deps.sandboxIntegration,
        resolveRequestContext,
        authorizer: deps.authorizer,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/internal/metrics',
    withAuth(
      createInternalMetricsRouter({
        sessionMetricsStore: deps.sessionMetricsStore,
        resolveRequestContext,
        resolveAgentStore: deps.resolveAgentStore,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/internal',
    withAuth(
      createPermissionsRouter({
        authorizer: deps.authorizer,
        resolveAgentStore: deps.resolveAgentStore,
        scheduleStore: deps.scheduleStore,
        sessionStore: deps.sessionStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createSessionsRouter({
        sessions: deps.sessions,
        sessionStore: deps.sessionStore,
        fileStore: deps.fileStore,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveAgentStore: deps.resolveAgentStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        sandboxIntegration: deps.sandboxIntegration,
        turnExecutor: deps.turnExecutor,
        resolveRequestContext,
        authorizer: deps.authorizer,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createTurnsRouter({
        sessions: deps.sessions,
        sessionStore: deps.sessionStore,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveAgentStore: deps.resolveAgentStore,
        turnExecutor: deps.turnExecutor,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        sandboxIntegration: deps.sandboxIntegration,
        logger: deps.logger,
        resolveRequestContext,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );

  const uiBasePath = getPublicUiBasePath();
  const openApiSpecPath = `${uiBasePath}api/v1/openapi.json`;
  const openApiServerUrl = uiBasePath === '/' ? undefined : uiBasePath.replace(/\/$/, '');
  app.get('/api/v1/docs', swaggerUI({ url: openApiSpecPath }));
  app.get('/api/v1/openapi.json', c =>
    c.json(
      buildOpenApiDocument(app, {
        authEnabled,
        ...(openApiServerUrl === undefined ? {} : { serverUrl: openApiServerUrl }),
      }),
    ),
  );

  app.notFound(routeNotFound);

  app.onError(createAppErrorHandler({ logger: deps.logger }));

  return app;
}
