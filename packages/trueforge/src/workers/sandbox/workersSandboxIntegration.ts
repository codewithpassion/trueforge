import { Sandbox } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import { HTTPException } from 'hono/http-exception';
import configuration from '../../config';
import type { SandboxIntegration } from '../../sandbox/integration';
import type { SandboxStatus } from '../../schemas/sandboxProvider';
import type { Env } from '../env';
import { sessionDurableObjectName } from '../sessionScope';
import { CloudflareComputerProvider } from './CloudflareComputerProvider';
import type { ComputerDO } from './ComputerDO';

/** `wrangler deploy` rolls the container image, so the workspace is ready as soon as it exists. */
const READY_STATUS: SandboxStatus = { status: 'ready', status_reason: null, build_metadata: null };

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

  return {
    resolveProvider: ({ tenant_id, sessionId }) => {
      if (options.backend === undefined) {
        return Promise.resolve(undefined);
      }
      const sandboxId = sessionDurableObjectName({ tenant_id, session_id: sessionId });
      return Promise.resolve(
        new CloudflareComputerProvider({
          computer: options.namespace.get(options.namespace.idFromName(sandboxId)),
          sandboxId,
          defaultExecTimeoutSeconds: options.defaultExecTimeoutSeconds,
          fileMaxBytesForDownload: options.fileMaxBytesForDownload,
        }),
      );
    },
    // The workspace comes from the deploy var, not from a stored settings record, so a
    // sandbox-enabled agent is valid with nothing in the sandbox-provider table.
    isLocalFallbackEnabled: () => options.backend !== undefined,
    // Phase 7b turns skills on once the image is confirmed to carry the downloader's dependencies.
    isSkillMountingSupported: () => false,
    isDaytonaSettingsSupported: () => false,
    checkSnapshotStatus: () => Promise.resolve(options.backend === undefined ? undefined : READY_STATUS),
    createDaytonaProvider: notSupported,
    isDaytonaAuthError: () => false,
    isDaytonaPermissionError: () => false,
    buildTurnSandbox: input => {
      if (input.skills.length > 0) {
        throw new HTTPException(422, { message: 'skills are not available on the Cloudflare Workers runtime' });
      }
      return new Sandbox({
        provider: input.provider,
        existingSandboxId: input.existingSandboxId,
        fileDownloadEnabled: input.fileDownloadEnabled,
        blockDestructiveToolsInCodeMode: true,
        mcpRequestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
        mcpConnectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
        tracing: input.tracing,
        logger: input.logger,
      });
    },
  };
}
