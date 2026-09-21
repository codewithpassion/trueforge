/**
 * Maps trueforge-ui sandbox-settings calls onto Harness
 * `/api/v1/settings/sandbox-providers` (singleton upsert).
 *
 * UI: multi-row providers with `id` / `catalogId` / `name` / flat `apiKey`.
 * Harness: one provider per tenant; the wire rows have no name — synthetic
 * identity uses `type` as id/catalogId and a display name per type.
 *
 * The built-in Cloudflare provider carries no credentials and nothing to tune.
 * `SandboxProviderConfig` still requires the four Daytona numbers, so they are
 * zero for it and the settings UI never shows them.
 */
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type {
  SandboxCatalogServer,
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  SandboxProviderConfig,
  SandboxProviderListEntry,
} from '../../../server/types.js';
import { CLOUDFLARE_COMPUTER_SANDBOX_TYPE } from '../../../utils/sandboxProviderType.js';

export type UiSandboxProvider = SandboxProviderBase;
export type UiSandboxProviderCatalogEntry = SandboxProviderCatalogEntry;
export type UiSandboxProviderListEntry = SandboxProviderListEntry;

const DAYTONA_TYPE = 'daytona';

const DISPLAY_NAMES: Record<string, string> = {
  [DAYTONA_TYPE]: 'Daytona',
  [CLOUDFLARE_COMPUTER_SANDBOX_TYPE]: 'Cloudflare Computer',
};

const NO_CONFIG: SandboxProviderConfig = {
  execTimeoutMs: 0,
  autoStopIntervalInMinutes: 0,
  autoArchiveIntervalInMinutes: 0,
  autoDeleteIntervalInMinutes: 0,
};

function displayNameForType(type: string): string {
  return DISPLAY_NAMES[type] ?? type;
}

export function configFromHarness(
  provider: TrueForgeApi.CatalogSandboxProvider | TrueForgeApi.SandboxProviderManifest,
): SandboxProviderConfig {
  if (provider.type === CLOUDFLARE_COMPUTER_SANDBOX_TYPE) {
    return NO_CONFIG;
  }
  return {
    execTimeoutMs: provider.execTimeoutMs,
    autoStopIntervalInMinutes: provider.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: provider.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: provider.autoDeleteIntervalInMinutes,
  };
}

export function toUiCatalogEntry(provider: TrueForgeApi.CatalogSandboxProvider): UiSandboxProviderCatalogEntry {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    type: provider.type,
    ...configFromHarness(provider),
  };
}

export function toUiSandboxProvider(provider: TrueForgeApi.SandboxProviderManifest): UiSandboxProvider {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    catalogId: provider.type,
    isConnected: true,
    ...configFromHarness(provider),
  };
}

export function toUiSandboxProviderListEntry(
  response: TrueForgeApi.GetSandboxProviderResponse['data'],
): UiSandboxProviderListEntry {
  return {
    data: toUiSandboxProvider(response.manifest),
    snapshotSyncStatus: {
      status: response.status,
      ...(response.statusReason ? { statusReason: response.statusReason } : {}),
    },
  };
}

export function filterUiSandboxProviders({
  providers,
  query,
}: {
  providers: UiSandboxProviderListEntry[];
  query?: string;
}): UiSandboxProviderListEntry[] {
  const normalizedQuery = query?.trim().toLowerCase();
  if (normalizedQuery === undefined || normalizedQuery === '') {
    return providers;
  }
  return providers.filter(
    provider =>
      provider.data.name.toLowerCase().includes(normalizedQuery) ||
      provider.data.id.toLowerCase().includes(normalizedQuery),
  );
}

export function toHarnessManifest(
  req: {
    type: string;
    apiKey: string;
  } & SandboxProviderConfig,
): TrueForgeApi.SandboxProviderManifest {
  if (req.type === CLOUDFLARE_COMPUTER_SANDBOX_TYPE) {
    return { type: CLOUDFLARE_COMPUTER_SANDBOX_TYPE };
  }
  if (req.type !== DAYTONA_TYPE) {
    throw new Error(`Unsupported sandbox provider type: ${req.type}`);
  }
  return {
    type: DAYTONA_TYPE,
    execTimeoutMs: req.execTimeoutMs,
    autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
    auth: { apiKey: req.apiKey },
  };
}

/** Settings sandbox-catalog port for `createTrueFoundryServer`. */
export function createSandboxProviderCatalog(client: TrueForge): SandboxCatalogServer {
  async function resolveApiKey(apiKey: string | undefined): Promise<string> {
    const trimmed = apiKey?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      return trimmed;
    }
    const existing = await client.settings.sandboxProviders.get();
    if (existing.data.manifest.type !== DAYTONA_TYPE) {
      throw new Error('The configured sandbox provider has no API key');
    }
    return existing.data.manifest.auth.apiKey;
  }

  return {
    getSandboxProviderCatalog: async () => {
      const body = await client.catalogs.sandboxProviders.list();
      return body.data.map(toUiCatalogEntry);
    },
    listSandboxProviders: async req => {
      let providers: UiSandboxProviderListEntry[];
      try {
        const body = await client.settings.sandboxProviders.get();
        providers = [toUiSandboxProviderListEntry(body.data)];
      } catch (err) {
        if (err instanceof TrueForgeApi.NotFoundError) {
          providers = [];
        } else {
          throw err;
        }
      }
      return filterUiSandboxProviders({ providers, query: req?.query });
    },
    createSandboxProvider: async req => {
      const body = await client.settings.sandboxProviders.createOrUpdate({
        manifest: toHarnessManifest({
          type: req.type,
          apiKey: req.apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      });
      return toUiSandboxProvider(body.data.manifest);
    },
    updateSandboxProvider: async req => {
      // The synthetic id is the provider type, so it says which manifest to rebuild.
      const type = req.id === CLOUDFLARE_COMPUTER_SANDBOX_TYPE ? CLOUDFLARE_COMPUTER_SANDBOX_TYPE : DAYTONA_TYPE;
      const apiKey = type === DAYTONA_TYPE ? await resolveApiKey(req.apiKey) : '';
      const body = await client.settings.sandboxProviders.createOrUpdate({
        manifest: toHarnessManifest({
          type,
          apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      });
      return toUiSandboxProvider(body.data.manifest);
    },
    deleteSandboxProvider: async () => {
      await client.settings.sandboxProviders.delete();
    },
  };
}
