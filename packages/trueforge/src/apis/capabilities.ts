import { OpenAPIHono } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context } from 'hono';
import { hasAdminRole, type ResolveRequestContext } from '../auth/identity';
import type { ComputersService } from '../computers/service';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import { getCapabilitiesRoute } from '../routes/capabilityRoutes';
import type { SandboxIntegration, SandboxUsability } from '../sandbox/integration';
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
  /** Undefined on a runtime that cannot reach a machine's relay, which reports computers off. */
  computers: ComputersService | undefined;
}) {
  const router = new OpenAPIHono();
  router.openapi(getCapabilitiesRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const settingsEnabled = hasAdminRole(requestContext);
    const computersEnabled = deps.computers !== undefined;
    const integration = deps.sandboxIntegration;
    if (integration === undefined) {
      return c.json(
        {
          data: {
            sandbox: { enabled: false },
            skill: { enabled: false, reason: 'Skills run in a sandbox, which this server does not support.' },
            settings: { enabled: settingsEnabled },
            computers: { enabled: computersEnabled },
          },
        },
        200,
      );
    }
    // The same question the agent-spec validator asks, so neither can admit what the other
    // refuses. Fail closed (disabled) if the status refresh throws.
    let usability: SandboxUsability = { usable: false, status: undefined, reason: undefined };
    try {
      usability = await integration.resolveSandboxUsability({
        store: deps.resolveSandboxProviderStore(c),
        tenant_id: requestContext.tenant_id,
        logger: deps.logger,
        // This endpoint has no spec, so it can only answer about the tenant's own provider.
        computer_id: undefined,
        agent_id: undefined,
        skills_requested: false,
      });
    } catch (error) {
      deps.logger.warn('Sandbox image status check failed; reporting sandbox disabled', extractErrorLogFields(error));
    }
    const sandboxEnabled = usability.usable;
    const skillEnabled = sandboxEnabled && integration.isSkillMountingSupported();
    return c.json(
      {
        data: {
          sandbox: { enabled: sandboxEnabled },
          skill: skillEnabled
            ? { enabled: true }
            : {
                enabled: false,
                reason: sandboxEnabled
                  ? 'Skills are not available on this server.'
                  : skillDisabledReason(usability.status),
              },
          settings: { enabled: settingsEnabled },
          computers: { enabled: computersEnabled },
        },
      },
      200,
    );
  });
  return router;
}
