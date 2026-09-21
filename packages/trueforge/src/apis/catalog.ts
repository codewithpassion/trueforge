import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { SUPPORTED_REASONING_EFFORTS } from '@truefoundry/trueforge-core/core/llm/VercelAILLM';
import type { McpCatalog } from '../catalog/McpCatalog';
import type { ModelCatalog } from '../catalog/ModelCatalog';
import type { SandboxCatalog } from '../catalog/SandboxCatalog';
import type { SkillCatalog } from '../catalog/SkillCatalog';
import {
  listMcpServerCatalogRoute,
  listModelProviderCatalogRoute,
  listSandboxProviderCatalogRoute,
  listSkillCatalogRoute,
} from '../routes/catalogRoutes';
import type { SandboxIntegration } from '../sandbox/integration';
import type { CatalogModelProvider } from '../schemas/modelCatalog';
import type { CatalogSandboxProvider } from '../schemas/sandboxCatalog';

export interface CatalogRouterDeps {
  modelCatalog: ModelCatalog;
  mcpCatalog: McpCatalog;
  skillCatalog: SkillCatalog;
  sandboxCatalog: SandboxCatalog;
  /** Undefined when this runtime cannot run sandboxes; the sandbox catalog is then empty. */
  sandboxIntegration: SandboxIntegration | undefined;
}

export function createCatalogRouter(deps: CatalogRouterDeps) {
  const listModelProvidersHandler: RouteHandler<typeof listModelProviderCatalogRoute> = c => {
    const loadedProvidersCatalog = deps.modelCatalog.list();
    // make a copy of the loaded providers catalog and add the custom provider sentinel
    const providersCatalog: CatalogModelProvider[] = [...loadedProvidersCatalog];
    providersCatalog.push({
      type: 'custom',
      supported_reasoning_efforts: [...SUPPORTED_REASONING_EFFORTS],
    });
    return c.json({ data: providersCatalog }, 200);
  };

  const listMcpServersHandler: RouteHandler<typeof listMcpServerCatalogRoute> = c => {
    return c.json({ data: [...deps.mcpCatalog.list()] }, 200);
  };

  const listSkillsHandler: RouteHandler<typeof listSkillCatalogRoute> = c => {
    return c.json({ data: [...deps.skillCatalog.list()] }, 200);
  };

  // Only offer what this deploy can actually run: the shipped Daytona presets, the built-in
  // provider, or neither.
  const listSandboxProvidersHandler: RouteHandler<typeof listSandboxProviderCatalogRoute> = c => {
    const integration = deps.sandboxIntegration;
    const providers: CatalogSandboxProvider[] = [];
    if (integration?.isDaytonaSettingsSupported() === true) {
      providers.push(...deps.sandboxCatalog.list());
    }
    if (integration?.isCloudflareComputerSettingsSupported() === true) {
      providers.push({ type: 'cloudflare-computer' });
    }
    return c.json({ data: providers }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listModelProviderCatalogRoute, listModelProvidersHandler);
  router.openapi(listMcpServerCatalogRoute, listMcpServersHandler);
  router.openapi(listSkillCatalogRoute, listSkillsHandler);
  router.openapi(listSandboxProviderCatalogRoute, listSandboxProvidersHandler);
  return router;
}
