import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { withTimeout } from '@truefoundry/trueforge-core/core/util/promiseUtils';
import type { Context } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import type { ISandboxProviderStore, SandboxProviderRecord } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import {
  deleteSandboxProviderRoute,
  getSandboxProviderRoute,
  putSandboxProviderRoute,
} from '../routes/sandboxProviderRoutes';
import type { SandboxIntegration } from '../sandbox/integration';
import {
  SANDBOX_READY_STATUS,
  toSandboxStatus,
  type DaytonaSandboxProvider,
  type SandboxProviderManifest,
  type StoredSandboxProviderManifest,
  type UpdateSandboxProviderRequest,
} from '../schemas/sandboxProvider';
import { MissingStoredSecretError, resolveStoredSecretValue, toRedactedSecretValue } from '../utils/secretRedaction';

/** Cap the Daytona register round-trip so a slow/unreachable provider can't hold the request (or DB txn) open. */
const BUILD_REQUEST_TIMEOUT_MS = 3_000;

const SANDBOX_UNSUPPORTED_MESSAGE = 'Sandbox providers are not supported by this server';

export interface SandboxProvidersRouterDeps<TTransaction> {
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
  sandboxIntegration: SandboxIntegration | undefined;
}

/** The integration only when this runtime serves at least one settings-managed provider. */
function settingsIntegration(integration: SandboxIntegration | undefined): SandboxIntegration | undefined {
  if (integration === undefined) {
    return undefined;
  }
  return integration.isDaytonaSettingsSupported() || integration.isCloudflareComputerSettingsSupported()
    ? integration
    : undefined;
}

/**
 * Whether this runtime serves the provider in question. `truefoundry` rows are env-synthesized,
 * never settings-managed, so they are not served either.
 */
function supportsManifest(
  integration: SandboxIntegration,
  manifest: StoredSandboxProviderManifest,
): manifest is SandboxProviderManifest {
  switch (manifest.type) {
    case 'daytona':
      return integration.isDaytonaSettingsSupported();
    case 'cloudflare-computer':
      return integration.isCloudflareComputerSettingsSupported();
    case 'truefoundry':
      return false;
  }
}

function redactSandboxProvider(manifest: SandboxProviderManifest): SandboxProviderManifest {
  if (manifest.type !== 'daytona') {
    return manifest;
  }
  return {
    ...manifest,
    auth: { api_key: toRedactedSecretValue(manifest.auth.api_key) },
  };
}

/** Admin/settings sandbox provider surface (mounted at /api/v1/settings/sandbox-providers). */
export function createSandboxProvidersRouter<TTransaction>(deps: SandboxProvidersRouterDeps<TTransaction>) {
  const getHandler: RouteHandler<typeof getSandboxProviderRoute> = async c => {
    const integration = settingsIntegration(deps.sandboxIntegration);
    if (integration === undefined) {
      return c.json({ error: { message: SANDBOX_UNSUPPORTED_MESSAGE } }, 404);
    }
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveSandboxProviderStore(c);
    const record = await store.getSandboxProvider(requestContext.tenant_id);
    // A row this runtime cannot run is not this tenant's provider — reporting it Ready would lie.
    // DELETE still removes it, which is how such a row gets cleaned up.
    if (record === undefined || !supportsManifest(integration, record.manifest)) {
      return c.json({ error: { message: 'No sandbox provider configured' } }, 404);
    }
    const manifest = record.manifest;
    // Refresh the persisted build status (and re-activate an idle snapshot) on every GET.
    const status = await integration.checkSnapshotStatus({
      store,
      tenant_id: requestContext.tenant_id,
      logger: deps.logger,
    });
    return c.json(
      {
        data: {
          manifest: redactSandboxProvider(manifest),
          status: status?.status ?? record.status,
          status_reason: status?.status_reason ?? record.status_reason,
        },
      },
      200,
    );
  };

  const putHandler: RouteHandler<typeof putSandboxProviderRoute> = async c => {
    const integration = settingsIntegration(deps.sandboxIntegration);
    const body: UpdateSandboxProviderRequest = c.req.valid('json');
    const incoming = body.manifest;
    if (integration === undefined || !supportsManifest(integration, incoming)) {
      return c.json({ error: { message: SANDBOX_UNSUPPORTED_MESSAGE } }, 422);
    }
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveSandboxProviderStore(c);

    if (incoming.type === 'cloudflare-computer') {
      // The container image ships with the deploy, so there is nothing to build or authenticate.
      const saved = await deps.withTransaction(transaction =>
        store.upsertSandboxProvider(
          { tenant_id: requestContext.tenant_id, manifest: incoming, ...SANDBOX_READY_STATUS },
          transaction,
        ),
      );
      return c.json({ data: { manifest: incoming, status: saved.status, status_reason: saved.status_reason } }, 200);
    }

    const resolveManifest = (existing: SandboxProviderRecord | undefined): DaytonaSandboxProvider => ({
      ...incoming,
      auth: {
        api_key: resolveStoredSecretValue({
          incoming: incoming.auth.api_key,
          existing: existing?.manifest.type === 'daytona' ? existing.manifest.auth.api_key : undefined,
        }),
      },
    });
    try {
      // NOTE: build (Daytona network I/O) runs inside the transaction for now; the design is being revisited.
      const { manifest, status } = await deps.withTransaction(async transaction => {
        const locked = await store.getSandboxProviderForUpdate(requestContext.tenant_id, transaction);
        const resolved = resolveManifest(locked);
        // Pass persisted build_metadata so a settings re-save does not start a new snapshot for a
        // bumped SANDBOX_IMAGE_URI (upgrades are unsupported — first configure has no metadata).
        const provider = integration.createDaytonaProvider({
          manifest: resolved,
          tenant_id: requestContext.tenant_id,
          logger: deps.logger,
          ...(locked ? { build_metadata: locked.build_metadata } : {}),
        });
        const built = toSandboxStatus(
          await withTimeout(provider.buildImage(), BUILD_REQUEST_TIMEOUT_MS, 'sandbox buildImage'),
        );
        await store.upsertSandboxProvider(
          { tenant_id: requestContext.tenant_id, manifest: resolved, ...built },
          transaction,
        );
        return { manifest: resolved, status: built };
      });
      return c.json(
        {
          data: {
            manifest: redactSandboxProvider(manifest),
            status: status.status,
            status_reason: status.status_reason,
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: 'API key is required' } }, 400);
      }
      if (integration.isDaytonaAuthError(error)) {
        return c.json({ error: { message: 'Daytona rejected the API key — check the credentials' } }, 422);
      }
      if (integration.isDaytonaPermissionError(error)) {
        return c.json(
          {
            error: {
              message:
                'Daytona denied access: the API key is missing required permissions. Grant write:sandboxes, write:snapshots, and delete:snapshots on the key in the Daytona dashboard, then try again.',
            },
          },
          422,
        );
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteSandboxProviderRoute> = async c => {
    const integration = settingsIntegration(deps.sandboxIntegration);
    if (integration === undefined) {
      return c.json({ error: { message: SANDBOX_UNSUPPORTED_MESSAGE } }, 404);
    }
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveSandboxProviderStore(c);
    const removed = await deps.withTransaction(transaction =>
      store.deleteSandboxProvider(requestContext.tenant_id, transaction),
    );
    if (!removed) {
      return c.json({ error: { message: 'No sandbox provider configured' } }, 404);
    }
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getSandboxProviderRoute, getHandler);
  router.openapi(putSandboxProviderRoute, putHandler);
  router.openapi(deleteSandboxProviderRoute, deleteHandler);
  return router;
}
