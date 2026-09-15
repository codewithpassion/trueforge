import { OpenAPIHono } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context } from 'hono';
import { hasAdminRole, type ResolveRequestContext } from '../auth/identity';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import { getCapabilitiesRoute } from '../routes/capabilityRoutes';
import type { SandboxIntegration } from '../sandbox/integration';
import type { SandboxBuildStatus } from '../schemas/sandboxProvider';

/**
 * Why skills are unavailable, keyed off the sandbox build status.
 * `pending` is transient (retry); everything else (no provider / failed / unknown) reads as not configured.
 */
function skillDisabledReason(status: SandboxBuildStatus | undefined): string {
  if (status === 'pending') {
    return 'Skills run in a sandbox whose image is still being prepared — retry shortly.';
  }
  return 'Skills run in a sandbox, which is not configured.';
}

export function createCapabilitiesRouter<TTransaction>(deps: {
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
  sandboxIntegration: SandboxIntegration | undefined;
}) {
  const router = new OpenAPIHono();
  router.openapi(getCapabilitiesRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const settingsEnabled = hasAdminRole(requestContext);
    const integration = deps.sandboxIntegration;
    if (integration === undefined) {
      return c.json(
        {
          data: {
            sandbox: { enabled: false },
            skill: { enabled: false, reason: 'Skills run in a sandbox, which this server does not support.' },
            settings: { enabled: settingsEnabled },
          },
        },
        200,
      );
    }
    // Sandbox is usable only when a provider is configured AND its image build reports ready.
    // Refresh the persisted status (and re-activate an idle snapshot); fail closed (disabled) if it throws.
    let status: SandboxBuildStatus | undefined;
    try {
      const refreshed = await integration.checkSnapshotStatus({
        store: deps.resolveSandboxProviderStore(c),
        tenant_id: requestContext.tenant_id,
        logger: deps.logger,
      });
      status = refreshed?.status;
    } catch (error) {
      deps.logger.warn('Sandbox image status check failed; reporting sandbox disabled', extractErrorLogFields(error));
    }
    const sandboxEnabled = status === 'ready' || (status === undefined && integration.isLocalFallbackEnabled());
    return c.json(
      {
        data: {
          sandbox: { enabled: sandboxEnabled },
          skill: sandboxEnabled ? { enabled: true } : { enabled: false, reason: skillDisabledReason(status) },
          settings: { enabled: settingsEnabled },
        },
      },
      200,
    );
  });
  return router;
}
