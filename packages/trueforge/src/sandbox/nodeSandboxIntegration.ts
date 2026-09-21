import { Sandbox } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import { SkillMounter } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import { join } from 'node:path';
import configuration from '../config';
import { CODE_MODE_SOCKET_PARENT, LOCAL_SANDBOX_ROOT_PARENT } from '../nodeConfig';
import type { SandboxIntegration } from './integration';
import { LocalSandboxProvider, type LocalSandboxSupportResult } from './local/provider/LocalSandboxProvider';
import {
  checkSnapshotStatus,
  isDaytonaAuthError,
  isDaytonaPermissionError,
  toDaytonaSandboxProvider,
  toSandboxProviderFromRecord,
} from './providerUtils';

/** Single path segment under the sandboxes parent (`_` when sessionId is missing or unsafe). */
export function localSandboxSessionSegment(sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId.length === 0 || sessionId.includes('/') || sessionId.includes('..')) {
    return '_';
  }
  return sessionId;
}

/**
 * Daytona / TrueFoundry providers from stored records, plus the standalone local fallback.
 * `localSupport` is the boot-time probe result; probing inits SRT, so never per request.
 */
export function createNodeSandboxIntegration({
  localSupport,
}: {
  localSupport: LocalSandboxSupportResult | undefined;
}): SandboxIntegration {
  // Never in TrueFoundry mode: that mode is distributed-only.
  const isLocalFallbackUsable = (): boolean =>
    configuration.RUNTIME === 'standalone' && localSupport?.supported === true;

  return {
    resolveProvider: async ({ tenant_id, store, logger, sessionId, computer_id }) => {
      // Remote computers ship on Workers first; this runtime has no relay to reach a machine
      // through, so an agent that names one gets nothing rather than the tenant's own sandbox.
      if (computer_id !== undefined) {
        return undefined;
      }
      const record = await store.getSandboxProvider(tenant_id);
      const stored = record === undefined ? undefined : toSandboxProviderFromRecord({ record, tenant_id, logger });
      if (stored !== undefined) {
        return stored;
      }
      if (!isLocalFallbackUsable() || localSupport === undefined) {
        return undefined;
      }
      return new LocalSandboxProvider({
        sandboxRootPathParent: join(LOCAL_SANDBOX_ROOT_PARENT, localSandboxSessionSegment(sessionId)),
        codeModeSocketParentPath: CODE_MODE_SOCKET_PARENT,
        support: localSupport,
        fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
        logger,
      });
    },
    resolveSandboxUsability: async ({ store, tenant_id, logger, computer_id }) => {
      if (computer_id !== undefined) {
        return { usable: false, status: undefined, reason: 'computers_disabled' };
      }
      // A build that is pending or failed is not usable yet, and the turn would reject it anyway.
      const refreshed = await checkSnapshotStatus({ store, tenant_id, logger });
      if (refreshed !== undefined) {
        return { usable: refreshed.status === 'ready', status: refreshed.status, reason: undefined };
      }
      return { usable: isLocalFallbackUsable(), status: undefined, reason: undefined };
    },
    isSkillMountingSupported: () => true,
    isDaytonaSettingsSupported: () => true,
    isCloudflareComputerSettingsSupported: () => false,
    checkSnapshotStatus,
    createDaytonaProvider: toDaytonaSandboxProvider,
    isDaytonaAuthError,
    isDaytonaPermissionError,
    buildTurnSandbox: input =>
      // Empty mounter still uploads requested-skills file so existing skills are cleaned up.
      new Sandbox({
        provider: input.provider,
        existingSandboxId: input.existingSandboxId,
        fileDownloadEnabled: input.fileDownloadEnabled,
        blockDestructiveToolsInCodeMode: true,
        mcpRequestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
        mcpConnectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
        skillMounter: new SkillMounter({ skills: input.skills }),
        tracing: input.tracing,
        logger: input.logger,
      }),
  };
}
