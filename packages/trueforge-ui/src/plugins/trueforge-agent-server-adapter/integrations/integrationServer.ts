/**
 * Maps trueforge-ui integration calls onto Harness `/api/v1/integrations`.
 *
 * UI: one flat row per channel connection, with credentials only ever written.
 * Harness: an `IntegrationManifest` document whose installed-only fields appear when the
 * channel app has been created and its credentials saved; the owning agent sits beside it.
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type {
  CreateIntegrationRequest,
  IntegrationBase,
  IntegrationServer,
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
    agentName: integration.agentName,
    allowedChannelIds: manifest.allowedChannelIds,
    allowDirectMessages: manifest.allowDirectMessages,
    approverUserIds: manifest.approverSlackUserIds ?? [],
    notificationRules: (manifest.notificationRules ?? []).map(rule => ({
      scheduleName: rule.scheduleName,
      channelId: rule.channelId,
      outcome: rule.outcome,
    })),
    ...(manifest.teamId === undefined ? {} : { externalAccountId: manifest.teamId }),
  };
}

export function toUiSetupManifest(manifest: TrueForgeApi.IntegrationAppManifest): IntegrationSetupManifest {
  return {
    requestUrl: manifest.requestUrl,
    interactionsRequestUrl: manifest.interactionsRequestUrl,
    manifestJson: manifest.manifestJson,
    createAppUrl: manifest.createAppUrl,
  };
}

/**
 * The workspace, the bot user and the credentials are never sent from the UI: the server
 * reads them from the channel when the credentials are saved.
 */
function toHarnessManifest(req: CreateIntegrationRequest | UpdateIntegrationRequest): TrueForgeApi.IntegrationManifest {
  const auth = 'auth' in req ? req.auth : undefined;
  return {
    type: SLACK_TYPE,
    botDisplayName: req.botDisplayName,
    allowedChannelIds: req.allowedChannelIds,
    allowDirectMessages: req.allowDirectMessages,
    approverSlackUserIds: req.approverUserIds,
    notificationRules: req.notificationRules.map(rule => ({
      scheduleName: rule.scheduleName,
      channelId: rule.channelId,
      outcome: rule.outcome,
    })),
    replyMode: 'thread',
    ...(auth === undefined ? {} : { auth: { botToken: auth.botToken, signingSecret: auth.signingSecret } }),
  };
}

export function createIntegrationServer(options: { client: TrueForge }): IntegrationServer {
  const { client } = options;
  return {
    listIntegrations: async req => {
      const agentNames = (req.agentNames ?? []).filter(name => name !== '');
      // The wire refuses an empty filter, so no names means no filter.
      const body = await client.integrations.list(agentNames.length === 0 ? {} : { agentNames: agentNames.join(',') });
      return body.data.map(toUiIntegration);
    },
    createIntegration: async req => {
      const body = await client.integrations.create({ agentName: req.agentName, manifest: toHarnessManifest(req) });
      return toUiIntegration(body.data);
    },
    updateIntegration: async req => {
      const body = await client.integrations.update(req.id, { manifest: toHarnessManifest(req) });
      return toUiIntegration(body.data);
    },
    deleteIntegration: async req => {
      await client.integrations.delete(req.id);
    },
    getIntegrationSetupManifest: async req => {
      const body = await client.integrations.getAppManifest(req.id);
      return toUiSetupManifest(body.data);
    },
  };
}
