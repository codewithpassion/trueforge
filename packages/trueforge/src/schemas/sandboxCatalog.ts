/**
 * Shipped sandbox-catalog.yaml schemas (discovery presets). Separate from
 * configured provider manifests in sandboxProvider.ts.
 */
import { z } from '@hono/zod-openapi';
import { CloudflareComputerSandboxProviderSchema, DAYTONA_SANDBOX_PROVIDER_SHAPE } from './sandboxProvider';

/** Daytona catalog preset: the manifest settings without credentials. */
export const CatalogDaytonaSandboxProviderSchema = z
  .object(DAYTONA_SANDBOX_PROVIDER_SHAPE)
  .strict()
  .openapi('CatalogDaytonaSandboxProvider');

/** The built-in provider carries no credentials, so its catalog row is its manifest. */
export const CatalogSandboxProviderSchema = z
  .discriminatedUnion('type', [CatalogDaytonaSandboxProviderSchema, CloudflareComputerSandboxProviderSchema])
  .openapi('CatalogSandboxProvider');

/** The shipped YAML lists Daytona presets; runtime-provided entries are not file-backed. */
export const SandboxCatalogFileSchema = z
  .object({
    providers: z.array(CatalogDaytonaSandboxProviderSchema),
  })
  .strict();

export const GetSandboxProviderCatalogResponseSchema = z
  .object({
    data: z.array(CatalogSandboxProviderSchema),
  })
  .openapi('GetSandboxProviderCatalogResponse');

export type CatalogDaytonaSandboxProvider = z.infer<typeof CatalogDaytonaSandboxProviderSchema>;
export type CatalogSandboxProvider = z.infer<typeof CatalogSandboxProviderSchema>;
export type SandboxCatalogFile = z.infer<typeof SandboxCatalogFileSchema>;
