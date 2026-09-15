/**
 * Admin/settings API surface under /api/v1/settings.
 * Sub-routers (model-providers, mcp-servers, skills, sandbox-providers) mount here.
 * Auth is applied at the /api/v1/settings mount boundary in app.ts (admin when auth is enabled).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import type { SandboxIntegration } from '../sandbox/integration';
import { createSettingsMcpServersRouter } from './mcpServers';
import { createModelProvidersRouter } from './modelProviders';
import { createSandboxProvidersRouter } from './sandboxProviders';
import { createSkillsRouter, type ResolveSkillStore } from './skills';

export interface SettingsRouterDeps<TTransaction> {
  resolveModelProviderStore: (c: Context) => IModelProviderStore<TTransaction>;
  resolveMcpServerStore: (c: Context) => IMcpServerWithAuthStore<TTransaction>;
  resolveSkillStore: ResolveSkillStore<TTransaction>;
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  sandboxIntegration: SandboxIntegration | undefined;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
}

export function createSettingsRouter<TTransaction>(deps: SettingsRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  router.route(
    '/model-providers',
    createModelProvidersRouter({
      resolveModelProviderStore: deps.resolveModelProviderStore,
      withTransaction: deps.withTransaction,
      resolveRequestContext: deps.resolveRequestContext,
    }),
  );
  router.route(
    '/mcp-servers',
    createSettingsMcpServersRouter({
      resolveMcpServerStore: deps.resolveMcpServerStore,
      withTransaction: deps.withTransaction,
      logger: deps.logger,
      resolveRequestContext: deps.resolveRequestContext,
    }),
  );
  router.route(
    '/skills',
    createSkillsRouter({
      resolveSkillStore: deps.resolveSkillStore,
      withTransaction: deps.withTransaction,
      resolveRequestContext: deps.resolveRequestContext,
    }),
  );
  router.route(
    '/sandbox-providers',
    createSandboxProvidersRouter({
      resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
      sandboxIntegration: deps.sandboxIntegration,
      withTransaction: deps.withTransaction,
      logger: deps.logger,
      resolveRequestContext: deps.resolveRequestContext,
    }),
  );
  return router;
}
