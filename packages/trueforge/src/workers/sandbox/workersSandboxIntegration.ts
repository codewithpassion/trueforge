import type { SandboxProvider } from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import { Sandbox } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import type { Skill } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import { SkillMounter } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import { HTTPException } from 'hono/http-exception';
import { desktopProviderTools } from '../../computers/desktopTools';
import { RemoteComputerProvider } from '../../computers/RemoteComputerProvider';
import { buildRemoteComputerProvider, resolveComputerUsability } from '../../computers/resolveComputer';
import type { ComputersService } from '../../computers/service';
import type { TurnDesktopLeases } from '../../computers/turnDesktopLeases';
import configuration from '../../config';
import type { ISandboxProviderStore } from '../../db/sandboxProviderStore';
import type { SandboxIntegration } from '../../sandbox/integration';
import { SANDBOX_READY_STATUS } from '../../schemas/sandboxProvider';
import { workersComputersService } from '../computersService';
import type { Env } from '../env';
import { sessionDurableObjectName } from '../sessionScope';
import { CloudflareComputerProvider } from './CloudflareComputerProvider';
import type { CodeModeBridgeRegistry } from './codeModeBridge';
import type { ComputerWorkspace } from './ComputerDO';

const NOT_SUPPORTED_MESSAGE = 'Daytona sandbox providers are not supported on the Cloudflare Workers runtime';

/**
 * Undefined means sandbox init sends no skill work at all. Only a computer that says it cannot run
 * the downloader gets that; the built-in workspace always mounts, so a dropped skill is cleaned up.
 */
function skillMounterFor(input: { provider: SandboxProvider; skills: readonly Skill[] }): SkillMounter | undefined {
  if (input.provider instanceof RemoteComputerProvider && !input.provider.supportsSkills) {
    return undefined;
  }
  return new SkillMounter({ skills: input.skills });
}

export interface WorkersSandboxIntegrationOptions {
  /** Unset means code execution stays off, which is the phase 5 behaviour. */
  backend: 'cloudflare-computer' | undefined;
  /** Remote computers. Undefined on a runtime that cannot reach their relays. */
  computers: ComputersService | undefined;
  /** Narrowed to what the provider uses, so a test can stand a workspace in without a container. */
  namespace: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): ComputerWorkspace };
  defaultExecTimeoutSeconds: number;
  fileMaxBytesForDownload: number;
  /**
   * Where a turn's Code Mode channel is opened. Only the object that runs turns serves one, so the
   * HTTP app leaves it unset and its providers report Code Mode as unsupported.
   */
  codeModeRegistry: CodeModeBridgeRegistry | undefined;
  /** Where providers record the desktops a turn may hold. Only the object that runs turns releases them. */
  desktopLeases: TurnDesktopLeases | undefined;
}

/** The deploy-configured integration, shared by the HTTP app and the session Durable Object. */
export function workersSandboxIntegrationFromEnv(params: {
  env: Pick<Env, 'COMPUTER_DO' | 'DB' | 'REMOTE_COMPUTER_DO' | 'RATE_LIMIT_DO'>;
  codeModeRegistry?: CodeModeBridgeRegistry | undefined;
  desktopLeases?: TurnDesktopLeases | undefined;
}): SandboxIntegration {
  return createWorkersSandboxIntegration({
    backend: configuration.TRUEFORGE_SANDBOX_BACKEND,
    computers: workersComputersService(params.env),
    namespace: params.env.COMPUTER_DO,
    defaultExecTimeoutSeconds: configuration.SANDBOX_EXEC_TIMEOUT_SECONDS,
    fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
    codeModeRegistry: params.codeModeRegistry,
    desktopLeases: params.desktopLeases,
  });
}

/** Sandbox support for the Workers runtime: one Cloudflare Computer workspace per session. */
export function createWorkersSandboxIntegration(options: WorkersSandboxIntegrationOptions): SandboxIntegration {
  function notSupported(): never {
    throw new HTTPException(422, { message: NOT_SUPPORTED_MESSAGE });
  }

  /**
   * The deploy var says the built-in sandbox is *available*; a stored record says the tenant
   * turned it on. Both must hold, so the capability endpoint, the spec validator and the turn
   * all read the same answer.
   */
  async function isEnabledForTenant(input: { store: ISandboxProviderStore; tenant_id: string }): Promise<boolean> {
    if (options.backend === undefined) {
      return false;
    }
    const record = await input.store.getSandboxProvider(input.tenant_id);
    return record?.manifest.type === 'cloudflare-computer';
  }

  return {
    resolveProvider: async ({ tenant_id, store, sessionId, computer_id, turn_id, logger }) => {
      // Checked before the built-in sandbox, so a tenant that never turned that on still gets its
      // computers. The caller has already cleared the agent through resolveSandboxUsability.
      if (computer_id !== undefined) {
        return options.computers === undefined
          ? undefined
          : await buildRemoteComputerProvider({
              computers: options.computers,
              tenantId: tenant_id,
              computerId: computer_id,
              sessionId,
              turnId: turn_id,
              defaultExecTimeoutSeconds: options.defaultExecTimeoutSeconds,
              fileMaxBytesForDownload: options.fileMaxBytesForDownload,
              desktopLeases: options.desktopLeases,
              logger,
            });
      }
      if (!(await isEnabledForTenant({ store, tenant_id }))) {
        return undefined;
      }
      const sandboxId = sessionDurableObjectName({ tenant_id, session_id: sessionId });
      return new CloudflareComputerProvider({
        computer: options.namespace.get(options.namespace.idFromName(sandboxId)),
        sandboxId,
        defaultExecTimeoutSeconds: options.defaultExecTimeoutSeconds,
        fileMaxBytesForDownload: options.fileMaxBytesForDownload,
        codeModeRegistry: options.codeModeRegistry,
      });
    },
    // The container image ships with the deploy, so an enabled workspace is never mid-build.
    resolveSandboxUsability: async input => {
      if (input.computer_id !== undefined) {
        return await resolveComputerUsability({
          computers: options.computers,
          selection: {
            tenant_id: input.tenant_id,
            computer_id: input.computer_id,
            agent_id: input.agent_id,
            skills_requested: input.skills_requested,
            desktop_requested: input.desktop_requested,
          },
        });
      }
      return (await isEnabledForTenant(input))
        ? { usable: true, status: 'ready', reason: undefined }
        : { usable: false, status: undefined, reason: undefined };
    },
    // The container image is the release sandbox image, so the skill downloader has the python3,
    // pydantic and git it needs; skills follow the workspace.
    isSkillMountingSupported: () => options.backend !== undefined,
    isDaytonaSettingsSupported: () => false,
    isCloudflareComputerSettingsSupported: () => options.backend !== undefined,
    // `wrangler deploy` rolls the container image, so an enabled workspace is ready at once.
    checkSnapshotStatus: async input => ((await isEnabledForTenant(input)) ? SANDBOX_READY_STATUS : undefined),
    createDaytonaProvider: notSupported,
    isDaytonaAuthError: () => false,
    isDaytonaPermissionError: () => false,
    buildTurnSandbox: input =>
      new Sandbox({
        provider: input.provider,
        existingSandboxId: input.existingSandboxId,
        fileDownloadEnabled: input.fileDownloadEnabled,
        blockDestructiveToolsInCodeMode: true,
        mcpRequestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
        mcpConnectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
        // The mounter runs even with no skills, so one the agent dropped is removed on the next
        // init. A machine that cannot run the downloader gets none at all: its init exec would
        // die on `import pydantic` and take every plain command down with it.
        skillMounter: skillMounterFor(input),
        providerTools:
          input.desktop && input.provider instanceof RemoteComputerProvider
            ? desktopProviderTools({ provider: input.provider, modelAcceptsToolImages: input.modelAcceptsToolImages })
            : undefined,
        tracing: input.tracing,
        logger: input.logger,
      }),
  };
}
