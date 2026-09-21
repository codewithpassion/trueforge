import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestContextFromCreatedBySubject } from '../auth/identity';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IIntegrationStore } from '../db/integrationStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { ISkillStore } from '../db/skillStore';
import type { IntegrationAdapterRegistry } from '../integrations/registry';
import { IntegrationRouter } from '../integrations/router';
import { TurnCompletionNotifier } from '../integrations/TurnCompletionNotifier';
import type { InboundRespond } from '../integrations/types';
import { postIntegrationEventsRoute } from '../routes/integrationRoutes';
import type { TurnExecutor } from '../runtime/turnExecutor';

/** Runtime + Context store resolvers needed to run a turn for an inbound channel event. */
export interface IntegrationEventsRouterDeps<TTransaction> {
  /** Persistence store: ingress carries no tenant, so the integration row supplies it. */
  integrationStore: IIntegrationStore<TTransaction>;
  adapters: IntegrationAdapterRegistry;
  sessions: Sessions;
  turnExecutor: TurnExecutor;
  resolveModelProviderStore: (c: Context, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction>;
  resolveMcpServerStore: (c: Context, runAsAgent?: AgentRecord) => IMcpServerWithAuthStore<TTransaction>;
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  /** Persistence agent store (the integration's agent binding is not caller-scoped). */
  agentStore: IAgentStore<TTransaction>;
  turnSkillsResolverStore: Pick<ISkillStore, 'resolveTurnSkills'>;
  logger: Logger;
}

function respond(c: Context, result: InboundRespond): Response {
  return c.body(result.body, result.status, {
    'content-type': result.content_type,
    'x-content-type-options': 'nosniff',
  });
}

/**
 * Keeps the post-start delivery flush off the acknowledgement the channel is waiting on.
 * Workers keeps the isolate alive with `waitUntil`; Node just lets the promise run.
 */
function deferOutsideResponse(c: Context, logger: Logger): (run: () => Promise<void>) => void {
  return run => {
    const settled = run().catch((error: unknown) => {
      logger.error('Deferred integration delivery failed', extractErrorLogFields(error));
    });
    try {
      // Hono throws rather than returning undefined when the runtime has no execution context.
      c.executionCtx.waitUntil(settled);
    } catch {
      // Node has none; the promise runs on its own and logs its own failures.
    }
  };
}

/**
 * Channel ingress (mounted at /api/v1/integrations). No user auth runs here: the adapter
 * verifies the channel's own signature, and the tenant comes from the stored integration.
 */
export function createIntegrationEventsRouter<TTransaction>(deps: IntegrationEventsRouterDeps<TTransaction>) {
  const notifier = new TurnCompletionNotifier({
    integrationStore: deps.integrationStore,
    adapters: deps.adapters,
    logger: deps.logger,
  });

  /** Built per request: turn stores are resolved from the request context set below. */
  const integrationRouterFor = (c: Context) =>
    new IntegrationRouter({
      integrationStore: deps.integrationStore,
      sessions: deps.sessions,
      agentStore: deps.agentStore,
      turnExecutor: deps.turnExecutor,
      deferDelivery: deferOutsideResponse(c, deps.logger),
      resolveTurnStores: (agent: AgentRecord) => ({
        agentStore: deps.agentStore,
        modelProviderStore: deps.resolveModelProviderStore(c, agent),
        mcpServerStore: deps.resolveMcpServerStore(c, agent),
        sandboxProviderStore: deps.resolveSandboxProviderStore(c),
        skillStore: deps.turnSkillsResolverStore,
      }),
      notifier,
      logger: deps.logger,
    });

  const handler: RouteHandler<typeof postIntegrationEventsRoute> = async c => {
    const { integration_id: integrationId } = c.req.valid('param');
    const integration = await deps.integrationStore.getIntegrationById({ id: integrationId });
    if (integration === undefined) {
      return c.json({ error: { message: `Integration not found: ${integrationId}` } }, 404);
    }
    const adapter = deps.adapters.get(integration.type);
    if (adapter === undefined) {
      return c.json({ error: { message: `No adapter for integration type ${integration.type}` } }, 501);
    }

    const received = await adapter.receive({
      request: c.req.raw,
      manifest: integration.manifest,
      integration_id: integration.id,
    });
    if (received.type === 'respond') {
      return respond(c, received);
    }
    if (received.type === 'rejected') {
      return c.json({ error: { message: received.reason } }, 401);
    }
    if (received.type === 'not_connected') {
      return c.json({ error: { message: received.reason } }, 409);
    }
    if (received.type === 'ignore') {
      return c.body(null, 200);
    }

    // Turns run as the admin who connected the integration, like schedule runs.
    c.set(
      'request_context',
      requestContextFromCreatedBySubject({
        tenant_id: integration.tenant_id,
        created_by_subject: integration.created_by_subject,
      }),
    );
    const routed = await integrationRouterFor(c).route({ integration, adapter, event: received.event });
    if (routed.type === 'agent_not_found') {
      throw new HTTPException(422, { message: `Agent not found: ${routed.agent_name}` });
    }
    if (routed.type === 'turn_failed') {
      // Every executor failure is the same thing to the channel: this event could not run, and
      // its dedupe row was released so a retry can. 422 is the route's declared answer for that.
      deps.logger.warn('Integration ingress could not run the event', {
        integrationId: integration.id,
        status: routed.failure.status,
        code: routed.failure.code,
      });
      throw new HTTPException(422, { message: routed.failure.message });
    }
    return c.body(null, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(postIntegrationEventsRoute, handler);
  return router;
}
