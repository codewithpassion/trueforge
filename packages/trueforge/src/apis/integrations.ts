import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createdBySubjectFromRequestContext, type ResolveRequestContext } from '../auth/identity';
import { IntegrationConflictError, type IIntegrationStore, type IntegrationRecord } from '../db/integrationStore';
import type { WithTransaction } from '../db/transaction';
import {
  createIntegrationRoute,
  deleteIntegrationRoute,
  getIntegrationRoute,
  listIntegrationsRoute,
  putIntegrationRoute,
} from '../routes/integrationRoutes';
import {
  integrationExternalAccountId,
  type CreateIntegrationRequest,
  type Integration,
  type IntegrationManifest,
  type UpdateIntegrationRequest,
} from '../schemas/integration';
import { newId } from '../utils/id';
import {
  isRedactedSecretValue,
  MissingStoredSecretError,
  resolveStoredSecretValue,
  toRedactedSecretValue,
} from '../utils/secretRedaction';

const CREDENTIALS_REQUIRED_MESSAGE =
  'Integration credentials are required; send real values when the channel account changes';

export interface IntegrationsRouterDeps<TTransaction> {
  resolveIntegrationStore: (c: Context) => IIntegrationStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}

function redactIntegration(manifest: IntegrationManifest): IntegrationManifest {
  return {
    ...manifest,
    auth: {
      bot_token: toRedactedSecretValue(manifest.auth.bot_token),
      signing_secret: toRedactedSecretValue(manifest.auth.signing_secret),
    },
  };
}

/** Real values set or rotate; redacted stand-ins keep what is stored. */
function resolveManifestForWrite({
  incoming,
  existing,
}: {
  incoming: IntegrationManifest;
  existing: IntegrationManifest | undefined;
}): IntegrationManifest {
  return {
    ...incoming,
    auth: {
      bot_token: resolveStoredSecretValue({
        incoming: incoming.auth.bot_token,
        existing: existing?.auth.bot_token,
      }),
      signing_secret: resolveStoredSecretValue({
        incoming: incoming.auth.signing_secret,
        existing: existing?.auth.signing_secret,
      }),
    },
  };
}

function toWireIntegration(record: IntegrationRecord): Integration {
  return {
    id: record.id,
    type: record.type,
    external_account_id: record.external_account_id,
    manifest: redactIntegration(record.manifest),
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Admin/settings integration surface (mounted at /api/v1/settings/integrations). */
export function createIntegrationsRouter<TTransaction>(deps: IntegrationsRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listIntegrationsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const records = await deps.resolveIntegrationStore(c).listIntegrations({ tenant_id: requestContext.tenant_id });
    return c.json({ data: records.map(toWireIntegration) }, 200);
  };

  const getHandler: RouteHandler<typeof getIntegrationRoute> = async c => {
    const { integration_id: integrationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps
      .resolveIntegrationStore(c)
      .getIntegration({ tenant_id: requestContext.tenant_id, id: integrationId });
    if (record === undefined) {
      return c.json({ error: { message: `Integration not found: ${integrationId}` } }, 404);
    }
    return c.json({ data: toWireIntegration(record) }, 200);
  };

  const createHandler: RouteHandler<typeof createIntegrationRoute> = async c => {
    const body: CreateIntegrationRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    try {
      // Create has no prior row, so a redacted stand-in resolves to MissingStoredSecretError → 400.
      const manifest = resolveManifestForWrite({ incoming: body.manifest, existing: undefined });
      const record = await deps.resolveIntegrationStore(c).createIntegration({
        id: newId(),
        tenant_id: requestContext.tenant_id,
        type: manifest.type,
        external_account_id: integrationExternalAccountId(manifest),
        manifest,
        created_by_subject: createdBySubjectFromRequestContext(requestContext),
      });
      return c.json({ data: toWireIntegration(record) }, 201);
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: CREDENTIALS_REQUIRED_MESSAGE } }, 400);
      }
      if (error instanceof IntegrationConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const putHandler: RouteHandler<typeof putIntegrationRoute> = async c => {
    const { integration_id: integrationId } = c.req.valid('param');
    const body: UpdateIntegrationRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveIntegrationStore(c);
    try {
      // Read and write in one transaction so a concurrent rotate cannot be overwritten by a keep.
      const record = await deps.withTransaction(async transaction => {
        const existing = await store.getIntegration(
          { tenant_id: requestContext.tenant_id, id: integrationId },
          transaction,
        );
        if (existing === undefined) {
          return undefined;
        }
        const manifest = resolveManifestForWrite({ incoming: body.manifest, existing: existing.manifest });
        // Moving to another channel account with a redacted credential would silently copy the
        // old account's secret onto the new one, which would never authenticate.
        if (
          integrationExternalAccountId(manifest) !== existing.external_account_id &&
          (isRedactedSecretValue(body.manifest.auth.bot_token) ||
            isRedactedSecretValue(body.manifest.auth.signing_secret))
        ) {
          throw new MissingStoredSecretError();
        }
        return store.updateIntegration(
          {
            tenant_id: requestContext.tenant_id,
            id: integrationId,
            external_account_id: integrationExternalAccountId(manifest),
            manifest,
          },
          transaction,
        );
      });
      if (record === undefined) {
        return c.json({ error: { message: `Integration not found: ${integrationId}` } }, 404);
      }
      return c.json({ data: toWireIntegration(record) }, 200);
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: CREDENTIALS_REQUIRED_MESSAGE } }, 400);
      }
      if (error instanceof IntegrationConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteIntegrationRoute> = async c => {
    const { integration_id: integrationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    await deps.resolveIntegrationStore(c).deleteIntegration({ tenant_id: requestContext.tenant_id, id: integrationId });
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listIntegrationsRoute, listHandler);
  router.openapi(createIntegrationRoute, createHandler);
  router.openapi(getIntegrationRoute, getHandler);
  router.openapi(putIntegrationRoute, putHandler);
  router.openapi(deleteIntegrationRoute, deleteHandler);
  return router;
}
