import type { SandboxProvider } from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import type { Sandbox } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import type { Skill } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import type { AgentTracing } from '@truefoundry/trueforge-core/core/tracing/AgentTracing';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { DaytonaSandboxProvider, SandboxBuildMetadata, SandboxStatus } from '../schemas/sandboxProvider';

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
  isSandboxUsableWithoutStoredRecord(): boolean;
  /**
   * Whether this tenant has a sandbox this runtime can actually run — a stored record of a
   * supported type, or a runtime fallback. The single source for every "is a sandbox
   * configured" answer, so the capability endpoint and the spec validator cannot disagree.
   */
  isSandboxConfigured(input: { store: ISandboxProviderStore; tenant_id: string }): Promise<boolean>;
  /** Whether skills can be mounted into a sandbox on this runtime. */
  isSkillMountingSupported(): boolean;
  /** Whether the settings-managed Daytona provider exists on this runtime. */
  isDaytonaSettingsSupported(): boolean;
  /** Whether the built-in Cloudflare Computer provider can be enabled from settings here. */
  isCloudflareComputerSettingsSupported(): boolean;
  /** Refreshed image build status of the stored provider; undefined when none is stored. */
  checkSnapshotStatus(input: {
    store: ISandboxProviderStore;
    tenant_id: string;
    logger: Logger;
  }): Promise<SandboxStatus | undefined>;
  /** Daytona provider for a settings manifest. No network I/O until a method is called. */
  createDaytonaProvider(input: {
    manifest: DaytonaSandboxProvider;
    tenant_id: string;
    logger: Logger;
    build_metadata?: SandboxBuildMetadata | null;
  }): SandboxProvider;
  /** Daytona rejected the credentials. */
  isDaytonaAuthError(error: unknown): boolean;
  /** Daytona credentials lack a required permission. */
  isDaytonaPermissionError(error: unknown): boolean;
  /** Sandbox for one turn from a resolved provider and skill mounts. */
  buildTurnSandbox(input: {
    provider: SandboxProvider;
    logger: Logger;
    skills: readonly Skill[];
    fileDownloadEnabled: boolean;
    existingSandboxId: string | undefined;
    tracing: AgentTracing;
  }): Sandbox;
}
