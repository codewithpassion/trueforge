import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { Context } from 'hono';
import { createdBySubjectFromRequestContext, type ResolveRequestContext } from '../auth/identity';
import { IntegrationConflictError, type IIntegrationStore, type IntegrationRecord } from '../db/integrationStore';
import type { WithTransaction } from '../db/transaction';
import { slackAuthTest, type SlackAuthTest } from '../integrations/slack/api';
import {
  buildSlackAppManifest,
  SLACK_CREATE_APP_URL,
  slackAppManifestJson,
  slackEventsRequestUrl,
  slackInteractionsRequestUrl,
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

/** The credential itself is wrong — the caller has something to fix. */
class ChannelRejectedCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelRejectedCredentialsError';
  }
}

/** The channel could not be asked, so the ids it owns cannot be filled in. */
class ChannelUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChannelUnavailableError';
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
  logger: Logger;
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
 *
 * `team_id` and `bot_user_id` are the channel's answer, not the caller's: an editor that
 * leaves them out keeps what is stored rather than sending the integration back to pending.
 * When a real token was supplied they already carry `auth.test`'s answer, so nothing is kept.
 */
function resolveManifestForWrite({
  incoming,
  existing,
}: {
  incoming: IntegrationManifest;
  existing: IntegrationManifest | undefined;
}): IntegrationManifest {
  const installed = {
    ...(incoming.team_id === undefined && existing?.team_id !== undefined ? { team_id: existing.team_id } : {}),
    ...(incoming.bot_user_id === undefined && existing?.bot_user_id !== undefined
      ? { bot_user_id: existing.bot_user_id }
      : {}),
  };
  const incomingAuth = incoming.auth;
  if (incomingAuth === undefined) {
    const kept = existing?.auth;
    return kept === undefined ? { ...incoming, ...installed } : { ...incoming, ...installed, auth: kept };
  }
  return {
    ...incoming,
    ...installed,
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

/**
 * Drops the workspace and bot user a caller sent. They are the channel's answer, never the
 * caller's: accepting them would let a request reserve a workspace it cannot prove it owns,
 * or rewrite the bot user an installed app reported.
 */
function withoutClaimedIdentity(manifest: IntegrationManifest): IntegrationManifest {
  const stripped = { ...manifest };
  delete stripped.team_id;
  delete stripped.bot_user_id;
  return stripped;
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
      if (identity.kind === 'rejected') {
        throw new ChannelRejectedCredentialsError(identity.error);
      }
      throw new ChannelUnavailableError(identity.error, { cause: identity.cause });
    }
    // Only a stored workspace can be contradicted; a caller never gets to name one.
    const stored = input.storedTeamId;
    if (stored !== undefined && stored !== identity.team_id) {
      throw new ChannelAccountMismatchError(
        `The bot token belongs to Slack workspace ${identity.team_id}, not ${stored}. ` +
          'Disconnect this integration and create a new one for that workspace.',
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
      const resolved = resolveManifestForWrite({
        incoming: withoutClaimedIdentity(body.manifest),
        existing: undefined,
      });
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
        return c.json({ error: { message: error.message } }, 422);
      }
      if (error instanceof ChannelUnavailableError) {
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
        manifest: withoutClaimedIdentity(body.manifest),
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
        // The account can only change when `auth.test` answered, which needs a real bot token;
        // a redacted signing secret with nothing stored has already failed above. So there is no
        // reachable way to land on a new account holding the old one's credentials.
        // TODO: compare (type, external_account_id) once a second channel type exists.
        const externalAccountId = integrationExternalAccountId({ manifest, integration_id: integrationId });
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
        return c.json({ error: { message: error.message } }, 422);
      }
      if (error instanceof ChannelUnavailableError) {
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
    } catch (error) {
      deps.logger.error('Could not resolve the public base URL for an app manifest', extractErrorLogFields(error));
      return c.json({ error: { message: 'PUBLIC_BASE_URL must be set to build the app manifest' } }, 500);
    }
    const requestUrl = slackEventsRequestUrl({ public_base_url: publicBaseUrl, integration_id: record.id });
    const interactionsRequestUrl = slackInteractionsRequestUrl({
      public_base_url: publicBaseUrl,
      integration_id: record.id,
    });
    const manifest = buildSlackAppManifest({
      bot_display_name: record.manifest.bot_display_name,
      request_url: requestUrl,
      interactions_request_url: interactionsRequestUrl,
    });
    return c.json(
      {
        data: {
          request_url: requestUrl,
          interactions_request_url: interactionsRequestUrl,
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
