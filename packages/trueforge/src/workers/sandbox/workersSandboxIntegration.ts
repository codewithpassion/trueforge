import { Sandbox } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import { SkillMounter } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import { HTTPException } from 'hono/http-exception';
import configuration from '../../config';
import type { ISandboxProviderStore } from '../../db/sandboxProviderStore';
import type { SandboxIntegration } from '../../sandbox/integration';
import { SANDBOX_READY_STATUS } from '../../schemas/sandboxProvider';
import type { Env } from '../env';
import { sessionDurableObjectName } from '../sessionScope';
import { CloudflareComputerProvider } from './CloudflareComputerProvider';
import type { ComputerDO } from './ComputerDO';

const NOT_SUPPORTED_MESSAGE = 'Daytona sandbox providers are not supported on the Cloudflare Workers runtime';

export interface WorkersSandboxIntegrationOptions {
  /** Unset means code execution stays off, which is the phase 5 behaviour. */
  backend: 'cloudflare-computer' | undefined;
  namespace: Pick<DurableObjectNamespace<ComputerDO>, 'get' | 'idFromName'>;
  defaultExecTimeoutSeconds: number;
  fileMaxBytesForDownload: number;
}

/** The deploy-configured integration, shared by the HTTP app and the session Durable Object. */
export function workersSandboxIntegrationFromEnv(env: Pick<Env, 'COMPUTER_DO'>): SandboxIntegration {
  return createWorkersSandboxIntegration({
    backend: configuration.TRUEFORGE_SANDBOX_BACKEND,
    namespace: env.COMPUTER_DO,
    defaultExecTimeoutSeconds: configuration.SANDBOX_EXEC_TIMEOUT_SECONDS,
    fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
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
    resolveProvider: async ({ tenant_id, store, sessionId }) => {
      if (!(await isEnabledForTenant({ store, tenant_id }))) {
        return undefined;
      }
      const sandboxId = sessionDurableObjectName({ tenant_id, session_id: sessionId });
      return new CloudflareComputerProvider({
        computer: options.namespace.get(options.namespace.idFromName(sandboxId)),
        sandboxId,
        defaultExecTimeoutSeconds: options.defaultExecTimeoutSeconds,
        fileMaxBytesForDownload: options.fileMaxBytesForDownload,
      });
    },
    isSandboxUsableWithoutStoredRecord: () => false,
    isSandboxConfigured: isEnabledForTenant,
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
      // The mounter runs even with no skills, so one the agent dropped is removed on the next init.
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
