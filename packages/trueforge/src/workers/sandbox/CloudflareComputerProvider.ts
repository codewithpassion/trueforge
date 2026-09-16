import type { CodeModeTransport } from '@truefoundry/trueforge-core/core/sandbox/codeMode/CodeModeTransport';
import type {
  ExecResult,
  SandboxBuild,
  SandboxExecParams,
  SandboxProvider,
} from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
} from '@truefoundry/trueforge-core/core/sandbox/SandboxErrors';
import type { ComputerWorkspace } from './ComputerDO';
import {
  COMPUTER_GIT_CREDENTIALS_PATH,
  COMPUTER_SKILL_DOWNLOADER_PATH,
  COMPUTER_SKILLS_DIR,
  COMPUTER_TOOL_RESULT_DIR,
  COMPUTER_UPLOADS_DIR,
  COMPUTER_WORKSPACE_ROOT,
} from './computerPaths';

export const CLOUDFLARE_COMPUTER_PROVIDER_TYPE = 'cloudflare-computer';

/** `wrangler deploy` builds and rolls the container image, so there is no runtime build. */
const READY_BUILD: SandboxBuild = { status: 'ready', reason: null, metadata: null };

export interface CloudflareComputerProviderOptions {
  computer: ComputerWorkspace;
  /** Workspace name of `computer`; the provider refuses any other sandbox id. */
  sandboxId: string;
  defaultExecTimeoutSeconds: number;
  fileMaxBytesForDownload: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks);
    }
    chunks.push(value);
  }
}

/**
 * One workspace per session, held by the session's `ComputerDO`. Every call is a Workers RPC that
 * keeps that object active for its duration.
 */
export class CloudflareComputerProvider implements SandboxProvider {
  readonly type = CLOUDFLARE_COMPUTER_PROVIDER_TYPE;
  readonly #computer: ComputerWorkspace;
  readonly #sandboxId: string;
  readonly #defaultExecTimeoutSeconds: number;
  readonly #fileMaxBytesForDownload: number;

  constructor(options: CloudflareComputerProviderOptions) {
    this.#computer = options.computer;
    this.#sandboxId = options.sandboxId;
    this.#defaultExecTimeoutSeconds = options.defaultExecTimeoutSeconds;
    this.#fileMaxBytesForDownload = options.fileMaxBytesForDownload;
  }

  buildImage(): Promise<SandboxBuild> {
    return Promise.resolve(READY_BUILD);
  }

  getImageBuildStatus(): Promise<SandboxBuild> {
    return Promise.resolve(READY_BUILD);
  }

  createSandbox(): Promise<{ sandboxId: string }> {
    return Promise.resolve({ sandboxId: this.#sandboxId });
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    this.#assertOwnSandbox(params.sandboxId);
    const timeoutSeconds = params.timeoutSeconds ?? this.#defaultExecTimeoutSeconds;
    let outcome;
    try {
      outcome = await this.#computer.execCommand({
        command: params.command,
        cwd: params.cwd ?? COMPUTER_WORKSPACE_ROOT,
        env: params.env ?? {},
        timeoutMs: timeoutSeconds * 1000,
      });
    } catch (error) {
      return { success: false, error: `Sandbox exec failed: ${errorMessage(error)}` };
    }
    if (outcome.status === 'cancelled') {
      return { success: false, error: `Sandbox exec timed out after ${String(timeoutSeconds)}s` };
    }
    if (outcome.status === 'failed') {
      return { success: false, error: `Sandbox exec did not run: ${outcome.output}` };
    }
    // The command ran, but its writes never reached the workspace store, so the result is not durable.
    if (outcome.syncPending) {
      return { success: false, error: `Sandbox filesystem sync is incomplete: ${outcome.syncError ?? 'unknown'}` };
    }
    return { success: true, response: { exitCode: outcome.exitCode, result: outcome.output } };
  }

  getAdditionalInstructions(): string {
    return `${COMPUTER_WORKSPACE_ROOT} persists for the whole session. The machine running commands may restart between commands, so re-create anything you installed outside ${COMPUTER_WORKSPACE_ROOT}.`;
  }

  getToolResultDumpDir(sandboxId: string): string {
    this.#assertOwnSandbox(sandboxId);
    return COMPUTER_TOOL_RESULT_DIR;
  }

  getGitCredentialsPath(sandboxId: string): string {
    this.#assertOwnSandbox(sandboxId);
    return COMPUTER_GIT_CREDENTIALS_PATH;
  }

  getFileUploadsDir(sandboxId: string): string {
    this.#assertOwnSandbox(sandboxId);
    return COMPUTER_UPLOADS_DIR;
  }

  getSkillsDir(sandboxId: string): string {
    this.#assertOwnSandbox(sandboxId);
    return COMPUTER_SKILLS_DIR;
  }

  getSkillDownloaderPath(sandboxId: string): string {
    this.#assertOwnSandbox(sandboxId);
    return COMPUTER_SKILL_DOWNLOADER_PATH;
  }

  async downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer> {
    this.#assertOwnSandbox(params.sandboxId);
    let outcome;
    try {
      outcome = await this.#computer.readFile({ path: params.path, maxBytes: this.#fileMaxBytesForDownload });
    } catch (error) {
      throw new SandboxNotAvailableError(params.sandboxId, { cause: error });
    }
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
          throw new SandboxFileNotFoundError(params.path);
        case 'is_directory':
          throw new SandboxPathIsDirectoryError(params.path);
        case 'too_large':
          throw new SandboxFileTooLargeError(params.path, outcome.size, this.#fileMaxBytesForDownload);
      }
    }
    return readAll(outcome.content);
  }

  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    this.#assertOwnSandbox(params.sandboxId);
    try {
      await this.#computer.writeFile({ path: params.remotePath, content: params.content });
    } catch (error) {
      throw new SandboxNotAvailableError(params.sandboxId, { cause: error });
    }
  }

  createCodeModeTransport(): CodeModeTransport {
    throw new Error('Code Mode is not available on the Cloudflare Computer sandbox');
  }

  /**
   * The workspace is fixed by the session this provider was built for. An id from another session
   * reads as gone, so the caller creates a fresh sandbox instead of reaching another workspace.
   */
  #assertOwnSandbox(sandboxId: string): void {
    if (sandboxId !== this.#sandboxId) {
      throw new SandboxNotAvailableError(sandboxId);
    }
  }
}
