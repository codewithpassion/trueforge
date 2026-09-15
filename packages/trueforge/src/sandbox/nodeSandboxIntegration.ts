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
  return {
    resolveProvider: async ({ tenant_id, store, logger, sessionId }) => {
      const record = await store.getSandboxProvider(tenant_id);
      if (record !== undefined) {
        return toSandboxProviderFromRecord({ record, tenant_id, logger });
      }
      if (configuration.RUNTIME !== 'standalone' || localSupport?.supported !== true) {
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
    // Never in TrueFoundry mode: that mode is distributed-only.
    isLocalFallbackEnabled: () => configuration.RUNTIME === 'standalone' && localSupport?.supported === true,
    checkSnapshotStatus,
    createDaytonaProvider: toDaytonaSandboxProvider,
    isDaytonaAuthError,
    isDaytonaPermissionError,
  };
}
