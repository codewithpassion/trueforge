import type { SandboxProvider } from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { SandboxBuildMetadata, SandboxProviderManifest, SandboxStatus } from '../schemas/sandboxProvider';

/**
 * Runtime-specific sandbox support. Routes receive `undefined` when the runtime cannot run
 * sandboxes, and then report sandbox features as unavailable.
 */
export interface SandboxIntegration {
  /** Provider for the tenant's stored record, else the local fallback when enabled. No network I/O. */
  resolveProvider(input: {
    tenant_id: string;
    store: ISandboxProviderStore;
    logger: Logger;
    sessionId: string;
  }): Promise<SandboxProvider | undefined>;
  /** Whether a sandbox is usable without a stored provider record. */
  isLocalFallbackEnabled(): boolean;
  /** Refreshed image build status of the stored provider; undefined when none is stored. */
  checkSnapshotStatus(input: {
    store: ISandboxProviderStore;
    tenant_id: string;
    logger: Logger;
  }): Promise<SandboxStatus | undefined>;
  /** Daytona provider for a settings manifest. No network I/O until a method is called. */
  createDaytonaProvider(input: {
    manifest: SandboxProviderManifest;
    tenant_id: string;
    logger: Logger;
    build_metadata?: SandboxBuildMetadata | null;
  }): SandboxProvider;
  /** Daytona rejected the credentials. */
  isDaytonaAuthError(error: unknown): boolean;
  /** Daytona credentials lack a required permission. */
  isDaytonaPermissionError(error: unknown): boolean;
}
