/**
 * Internal import under /api/internal/import (agents + sessions + checkpoint).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { AgentExternalIdConflictError, AgentNameConflictError, type IAgentStore } from '../db/agentStore';
import { SessionImportValidationError, type SessionImport } from '../db/sessionImport';
import { getImportSessionsCheckpointRoute, importAgentsRoute, importSessionRoute } from '../routes/agentImportRoutes';
import type { ImportAgentItemResult } from '../schemas/agentImport';
import { TFY_ASSUME_USER_HEADER, tenantSystemAssumeUserHeader } from '../truefoundry/assumeUserHeaders';

export interface AgentImportRouterDeps {
  /** Undefined when the session store cannot import (e.g. standalone SQLite). */
  sessionImport: SessionImport | undefined;
  /** TrueFoundryAgentStore (or DB store) with SF client assume-user headers when needed. */
  resolveImportAgentStore: (serviceFoundryServerHeaders: Record<string, string>) => IAgentStore;
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.stack ? `${error.message}\n${error.stack}` : error.message;
}

function requireSessionImport(sessionImport: SessionImport | undefined): SessionImport {
  if (sessionImport === undefined) {
    throw new HTTPException(500, {
      message: 'Session import requires Postgres (STANDALONE=false)',
    });
  }
  return sessionImport;
}

export function createAgentImportRouter(deps: AgentImportRouterDeps) {
  const router = new OpenAPIHono();

  const importAgentsHandler: RouteHandler<typeof importAgentsRoute> = async c => {
    const { agents } = c.req.valid('json');
    const results: ImportAgentItemResult[] = [];
    const first = agents[0];
    if (first === undefined) {
      return c.json({ data: { results } }, 200);
    }

    const agentStore = deps.resolveImportAgentStore({
      [TFY_ASSUME_USER_HEADER]: tenantSystemAssumeUserHeader(first.tenant_id),
    });

    for (const agent of agents) {
      try {
        const created = await agentStore.createAgent({
          tenant_id: agent.tenant_id,
          name: agent.name,
          description: agent.description ?? agent.name,
          manifest: agent.manifest,
          external_id: null,
          created_by_subject: agent.created_by_subject,
          custom: {
            trueFoundryManagedAgentId: agent.truefoundry_managed_agent_id,
          },
        });
        results.push({
          name: created.name,
          tenant_id: agent.tenant_id,
          status: 'created',
          agent_id: created.id,
        });
      } catch (error) {
        if (error instanceof AgentNameConflictError || error instanceof AgentExternalIdConflictError) {
          results.push({ name: agent.name, tenant_id: agent.tenant_id, status: 'exists' });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name: agent.name, tenant_id: agent.tenant_id, status: 'failed', error: message });
      }
    }

    return c.json({ data: { results } }, 200);
  };

  const importSessionHandler: RouteHandler<typeof importSessionRoute> = async c => {
    const sessionImport = requireSessionImport(deps.sessionImport);
    const body = c.req.valid('json');
    try {
      const result = await sessionImport.importSessionSnapshot(body);
      if (!result.imported) {
        return c.json({ data: result }, 409);
      }
      return c.json({ data: result }, 201);
    } catch (error) {
      if (error instanceof SessionImportValidationError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw new HTTPException(500, { message: errorDetail(error), cause: error });
    }
  };

  const checkpointHandler: RouteHandler<typeof getImportSessionsCheckpointRoute> = async c => {
    const sessionImport = requireSessionImport(deps.sessionImport);
    const { tenant_id } = c.req.valid('query');
    try {
      const data = await sessionImport.getImportSessionsCheckpoint({ tenant_id });
      return c.json({ data }, 200);
    } catch (error) {
      throw new HTTPException(500, { message: errorDetail(error), cause: error });
    }
  };

  router.openapi(importAgentsRoute, importAgentsHandler);
  router.openapi(importSessionRoute, importSessionHandler);
  router.openapi(getImportSessionsCheckpointRoute, checkpointHandler);
  return router;
}
