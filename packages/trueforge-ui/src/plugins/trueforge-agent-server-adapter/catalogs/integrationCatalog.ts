/**
 * Maps trueforge-ui integration-settings calls onto Harness
 * `/api/v1/settings/integrations`.
 *
 * UI: one flat row per channel connection, with credentials only ever written.
 * Harness: an `IntegrationManifest` document whose installed-only fields appear when the
 * channel app has been created and its credentials saved.
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type {
  CreateIntegrationRequest,
  IntegrationBase,
  IntegrationCatalogServer,
  IntegrationSetupManifest,
  UpdateIntegrationRequest,
} from '../../../server/types.js';

const SLACK_TYPE = 'slack';

export function toUiIntegration(integration: TrueForgeApi.Integration): IntegrationBase {
  const { manifest } = integration;
  return {
    id: integration.id,
    type: integration.type,
    status: integration.status,
    botDisplayName: manifest.botDisplayName ?? '',
    defaultAgentName: manifest.defaultAgentName,
    allowedChannelIds: manifest.allowedChannelIds,
    allowDirectMessages: manifest.allowDirectMessages,
    ...(manifest.teamId === undefined ? {} : { externalAccountId: manifest.teamId }),
  };
}

export function toUiSetupManifest(manifest: TrueForgeApi.IntegrationAppManifest): IntegrationSetupManifest {
  return {
    requestUrl: manifest.requestUrl,
    manifestJson: manifest.manifestJson,
    createAppUrl: manifest.createAppUrl,
  };
}

/**
 * The workspace, the bot user and the credentials are never sent from the UI: the server
 * reads them from the channel when the credentials are saved.
 */
function toHarnessManifest(
  req: CreateIntegrationRequest | UpdateIntegrationRequest,
): TrueForgeApi.IntegrationManifest {
  const auth = 'auth' in req ? req.auth : undefined;
  return {
    type: SLACK_TYPE,
    botDisplayName: req.botDisplayName,
    defaultAgentName: req.defaultAgentName,
    allowedChannelIds: req.allowedChannelIds,
    allowDirectMessages: req.allowDirectMessages,
    replyMode: 'thread',
    ...(auth === undefined ? {} : { auth: { botToken: auth.botToken, signingSecret: auth.signingSecret } }),
  };
}

/** Settings integration-catalog port for `createTrueFoundryServer`. */
export function createIntegrationCatalog(client: TrueForge): IntegrationCatalogServer {
  return {
    listIntegrations: async () => {
      const body = await client.settings.integrations.list();
      return body.data.map(toUiIntegration);
    },
    createIntegration: async req => {
      const body = await client.settings.integrations.create({ manifest: toHarnessManifest(req) });
      return toUiIntegration(body.data);
    },
    updateIntegration: async req => {
      const body = await client.settings.integrations.update(req.id, { manifest: toHarnessManifest(req) });
      return toUiIntegration(body.data);
    },
    deleteIntegration: async req => {
      await client.settings.integrations.delete(req.id);
    },
    getIntegrationSetupManifest: async req => {
      const body = await client.settings.integrations.getAppManifest(req.id);
      return toUiSetupManifest(body.data);
    },
  };
}
