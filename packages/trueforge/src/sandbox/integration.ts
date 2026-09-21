import type { SandboxProvider } from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import type { Sandbox } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import type { Skill } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import type { AgentTracing } from '@truefoundry/trueforge-core/core/tracing/AgentTracing';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type {
  DaytonaSandboxProvider,
  SandboxBuildMetadata,
  SandboxBuildStatus,
  SandboxStatus,
} from '../schemas/sandboxProvider';

/**
 * Why a sandbox cannot run, or why it can run but may still refuse at turn time. Without this the
 * four remote-computer answers below are one boolean, and the caller cannot say which one it is.
 */
export const SANDBOX_USABILITY_REASONS = [
  'unknown_computer',
  'computer_revoked',
  'agent_not_allowed',
  'inline_agent',
  'computers_disabled',
  'computer_offline',
] as const;
export type SandboxUsabilityReason = (typeof SANDBOX_USABILITY_REASONS)[number];

/** Whether a sandbox can run for a tenant now, and the build status behind that answer. */
export interface SandboxUsability {
  usable: boolean;
  /** Undefined when no record this runtime can run is stored. */
  status: SandboxBuildStatus | undefined;
  /**
   * Undefined when the plain tenant provider answered. `computer_offline` is the only reason that
   * still leaves `usable` true: a laptop is asleep most of the time, and refusing to save or start
   * an agent for that would be wrong. Every other reason is a refusal.
   */
  reason: SandboxUsabilityReason | undefined;
}

/**
 * Runtime-specific sandbox support. Routes receive `undefined` when the runtime cannot run
 * sandboxes, and then report sandbox features as unavailable.
 */
export interface SandboxIntegration {
  /**
   * Provider for the agent's chosen remote computer, else the tenant's stored record, else the
   * local fallback when enabled. No network I/O beyond reading the computer row.
   */
  resolveProvider(input: {
    tenant_id: string;
    store: ISandboxProviderStore;
    logger: Logger;
    sessionId: string;
    /** From `spec.config.sandbox.computer_id`; set means the tenant provider is bypassed. */
    computer_id: string | undefined;
    /** Recorded on every command the computer runs. Null off the turn path, e.g. file download. */
    turn_id: string | null;
  }): Promise<SandboxProvider | undefined>;
  /**
   * Whether a sandbox can run for this tenant right now: a stored record this runtime can attach
   * to whose image build is ready, or a runtime fallback that needs no record. The single source
   * for the capability endpoint and the spec validator, so neither can admit what the other
   * refuses. Refreshes the persisted build status, so it may do provider network I/O.
   */
  resolveSandboxUsability(input: {
    store: ISandboxProviderStore;
    tenant_id: string;
    logger: Logger;
    /** From `spec.config.sandbox.computer_id`; set means the computer is checked, not the provider. */
    computer_id: string | undefined;
    /**
     * The immutable id of the saved agent this spec belongs to. `undefined` is an inline agent,
     * which may not use a computer: access is granted per agent, and there is nothing to grant to.
     */
    agent_id: string | undefined;
  }): Promise<SandboxUsability>;
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
