import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createdBySubjectFromRequestContext, type ResolveRequestContext } from '../auth/identity';
import { IntegrationConflictError, type IIntegrationStore, type IntegrationRecord } from '../db/integrationStore';
import type { WithTransaction } from '../db/transaction';
import { slackAuthTest, type SlackAuthTest } from '../integrations/slack/api';
import {
  buildSlackAppManifest,
  slackAppManifestJson,
  slackEventsRequestUrl,
  SLACK_CREATE_APP_URL,
} from '../integrations/slack/appManifest';
import {
  createIntegrationRoute,
  deleteIntegrationRoute,
  getIntegrationAppManifestRoute,
  getIntegrationRoute,
  listIntegrationsRoute,
  putIntegrationRoute,
} from '../routes/integrationRoutes';
import {
  integrationExternalAccountId,
  integrationStatus,
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

/** The channel would not confirm the credentials, so the ids they identify cannot be filled in. */
class ChannelRejectedCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelRejectedCredentialsError';
  }
}

/** The credentials belong to a different channel account than the one already stored. */
class ChannelAccountMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelAccountMismatchError';
  }
}

export interface IntegrationsRouterDeps<TTransaction> {
  resolveIntegrationStore: (c: Context) => IIntegrationStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  /** Public origin the channel posts events back to. */
  publicBaseUrl: () => string;
  /** Overridden in tests so no unit test reaches slack.com. */
  slackAuthTest?: SlackAuthTest;
}

function redactIntegration(manifest: IntegrationManifest): IntegrationManifest {
  if (manifest.auth === undefined) {
    return manifest;
  }
  return {
    ...manifest,
    auth: {
      bot_token: toRedactedSecretValue(manifest.auth.bot_token),
      signing_secret: toRedactedSecretValue(manifest.auth.signing_secret),
    },
  };
}

/**
 * Real values set or rotate; redacted stand-ins and an omitted `auth` keep what is stored.
 * A manifest with no credentials on either side stays pending.
 */
function resolveManifestForWrite({
  incoming,
  existing,
}: {
  incoming: IntegrationManifest;
  existing: IntegrationManifest | undefined;
}): IntegrationManifest {
  const incomingAuth = incoming.auth;
  if (incomingAuth === undefined) {
    const kept = existing?.auth;
    return kept === undefined ? { ...incoming } : { ...incoming, auth: kept };
  }
  return {
    ...incoming,
    auth: {
      bot_token: resolveStoredSecretValue({
        incoming: incomingAuth.bot_token,
        existing: existing?.auth?.bot_token,
      }),
      signing_secret: resolveStoredSecretValue({
        incoming: incomingAuth.signing_secret,
        existing: existing?.auth?.signing_secret,
      }),
    },
  };
}

/**
 * A real bot token in the request is the only case where the server holds a credential that
 * did not come out of the database, so it is the only case that asks the channel who it is.
 */
function suppliedBotToken(manifest: IntegrationManifest): string | undefined {
  const token = manifest.auth?.bot_token;
  return token === undefined || isRedactedSecretValue(token) ? undefined : token;
}

function toWireIntegration(record: IntegrationRecord): Integration {
  return {
    id: record.id,
    type: record.type,
    status: integrationStatus(record.manifest),
    external_account_id: record.external_account_id,
    manifest: redactIntegration(record.manifest),
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Admin/settings integration surface (mounted at /api/v1/settings/integrations). */
export function createIntegrationsRouter<TTransaction>(deps: IntegrationsRouterDeps<TTransaction>) {
  const authTest = deps.slackAuthTest ?? slackAuthTest;

  /**
   * Fills the workspace and bot ids from the channel so nobody copies them by hand, and
   * refuses a token that belongs to a workspace other than the one already stored.
   */
  const withChannelIdentity = async (input: {
    manifest: IntegrationManifest;
    storedTeamId: string | undefined;
  }): Promise<IntegrationManifest> => {
    const botToken = suppliedBotToken(input.manifest);
    if (botToken === undefined) {
      return input.manifest;
    }
    const identity = await authTest({ botToken });
    if (!identity.ok) {
      throw new ChannelRejectedCredentialsError(identity.error);
    }
    const claimed = input.manifest.team_id ?? input.storedTeamId;
    if (claimed !== undefined && claimed !== identity.team_id) {
      throw new ChannelAccountMismatchError(
        `The bot token belongs to Slack workspace ${identity.team_id}, not ${claimed}`,
      );
    }
    return { ...input.manifest, team_id: identity.team_id, bot_user_id: identity.bot_user_id };
  };

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
      const resolved = resolveManifestForWrite({ incoming: body.manifest, existing: undefined });
      const manifest = await withChannelIdentity({ manifest: resolved, storedTeamId: undefined });
      const id = newId();
      const record = await deps.resolveIntegrationStore(c).createIntegration({
        id,
        tenant_id: requestContext.tenant_id,
        type: manifest.type,
        external_account_id: integrationExternalAccountId({ manifest, integration_id: id }),
        manifest,
        created_by_subject: createdBySubjectFromRequestContext(requestContext),
      });
      return c.json({ data: toWireIntegration(record) }, 201);
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: CREDENTIALS_REQUIRED_MESSAGE } }, 400);
      }
      if (error instanceof IntegrationConflictError || error instanceof ChannelAccountMismatchError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      if (error instanceof ChannelRejectedCredentialsError) {
        return c.json({ error: { message: error.message } }, 502);
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
      // The channel call must finish before the transaction opens; it is remote I/O.
      const before = await store.getIntegration({ tenant_id: requestContext.tenant_id, id: integrationId });
      if (before === undefined) {
        return c.json({ error: { message: `Integration not found: ${integrationId}` } }, 404);
      }
      // Identity comes from the caller's own token, so it does not go stale if the stored
      // credentials change underneath: an omitted or redacted token asks the channel nothing.
      const identified = await withChannelIdentity({
        manifest: body.manifest,
        storedTeamId: before.manifest.team_id,
      });

      // Read and write in one transaction so a concurrent rotate cannot be overwritten by a keep.
      const record = await deps.withTransaction(async transaction => {
        const existing = await store.getIntegration(
          { tenant_id: requestContext.tenant_id, id: integrationId },
          transaction,
        );
        if (existing === undefined) {
          return undefined;
        }
        const manifest = resolveManifestForWrite({ incoming: identified, existing: existing.manifest });
        const externalAccountId = integrationExternalAccountId({ manifest, integration_id: integrationId });
        // Moving to another channel account with a redacted credential would silently copy the
        // old account's secret onto the new one, which would never authenticate.
        // TODO: compare (type, external_account_id) once a second channel type exists.
        if (externalAccountId !== existing.external_account_id && suppliedBotToken(body.manifest) === undefined) {
          throw new MissingStoredSecretError();
        }
        return store.updateIntegration(
          {
            tenant_id: requestContext.tenant_id,
            id: integrationId,
            external_account_id: externalAccountId,
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
      if (error instanceof IntegrationConflictError || error instanceof ChannelAccountMismatchError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      if (error instanceof ChannelRejectedCredentialsError) {
        return c.json({ error: { message: error.message } }, 502);
      }
      throw error;
    }
  };

  const appManifestHandler: RouteHandler<typeof getIntegrationAppManifestRoute> = async c => {
    const { integration_id: integrationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps
      .resolveIntegrationStore(c)
      .getIntegration({ tenant_id: requestContext.tenant_id, id: integrationId });
    if (record === undefined) {
      return c.json({ error: { message: `Integration not found: ${integrationId}` } }, 404);
    }
    let publicBaseUrl: string;
    try {
      publicBaseUrl = deps.publicBaseUrl();
    } catch {
      return c.json({ error: { message: 'PUBLIC_BASE_URL must be set to build the app manifest' } }, 500);
    }
    const requestUrl = slackEventsRequestUrl({ public_base_url: publicBaseUrl, integration_id: record.id });
    const manifest = buildSlackAppManifest({
      bot_display_name: record.manifest.bot_display_name,
      request_url: requestUrl,
    });
    return c.json(
      {
        data: {
          request_url: requestUrl,
          manifest_json: slackAppManifestJson(manifest),
          create_app_url: SLACK_CREATE_APP_URL,
        },
      },
      200,
    );
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
  router.openapi(getIntegrationAppManifestRoute, appManifestHandler);
  router.openapi(putIntegrationRoute, putHandler);
  router.openapi(deleteIntegrationRoute, deleteHandler);
  return router;
}
