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
import { CloudflareComputerCodeModeTransport } from './CloudflareComputerCodeModeTransport';
import type { CodeModeBridgeRegistry } from './codeModeBridge';
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

/**
 * The platform reports a refused container at the tail of a transport string that opens with a
 * health-check timeout, so only this phrase tells the capacity limit from a broken container.
 */
const INSTANCE_LIMIT_MARKER = 'Maximum number of running container instances exceeded';

const INSTANCE_LIMIT_MESSAGE =
  'No sandbox could start: the deploy is already running its max_instances limit of containers. Retry in a few minutes.';

/** `wrangler deploy` builds and rolls the container image, so there is no runtime build. */
const READY_BUILD: SandboxBuild = { status: 'ready', reason: null, metadata: null };

export interface CloudflareComputerProviderOptions {
  computer: ComputerWorkspace;
  /** Workspace name of `computer`; the provider refuses any other sandbox id. */
  sandboxId: string;
  defaultExecTimeoutSeconds: number;
  fileMaxBytesForDownload: number;
  /** Absent on a runtime that serves no Code Mode bridge, which is what turns the feature off. */
  codeModeRegistry: CodeModeBridgeRegistry | undefined;
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
  /** Only a runtime that serves the Code Mode bridge can offer it; the HTTP app cannot. */
  readonly supportsCodeMode: boolean;
  readonly #computer: ComputerWorkspace;
  readonly #sandboxId: string;
  readonly #defaultExecTimeoutSeconds: number;
  readonly #fileMaxBytesForDownload: number;
  readonly #codeModeRegistry: CodeModeBridgeRegistry | undefined;

  constructor(options: CloudflareComputerProviderOptions) {
    this.#computer = options.computer;
    this.#sandboxId = options.sandboxId;
    this.#defaultExecTimeoutSeconds = options.defaultExecTimeoutSeconds;
    this.#fileMaxBytesForDownload = options.fileMaxBytesForDownload;
    this.#codeModeRegistry = options.codeModeRegistry;
    this.supportsCodeMode = options.codeModeRegistry !== undefined;
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
      const message = errorMessage(error);
      // A refused container is not a gone sandbox: the workspace is intact in Durable Object
      // storage, and recreating it would only spend the container health-check budget a second
      // time before the caller ever sees why. So this stays a failed command.
      if (message.includes(INSTANCE_LIMIT_MARKER)) {
        return { success: false, error: INSTANCE_LIMIT_MESSAGE };
      }
      return { success: false, error: `Sandbox exec failed: ${message}` };
    }
    if (outcome.status === 'cancelled') {
      return { success: false, error: `Sandbox exec timed out after ${String(timeoutSeconds)}s` };
    }
    // Computer derives `failed` from any non-zero exit, so the status alone cannot tell a shell
    // error from a command that never launched. Only a missing exit event leaves the code negative,
    // and that is the one case the sandbox contract reports as an infrastructure failure.
    if (outcome.exitCode < 0) {
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

  // The layout is fixed for every workspace, and the prompt asks for it before a sandbox exists
  // (the id is then empty), so the getters take no view on which sandbox they describe.
  getToolResultDumpDir(): string {
    return COMPUTER_TOOL_RESULT_DIR;
  }

  getGitCredentialsPath(): string {
    return COMPUTER_GIT_CREDENTIALS_PATH;
  }

  getFileUploadsDir(): string {
    return COMPUTER_UPLOADS_DIR;
  }

  getSkillsDir(): string {
    return COMPUTER_SKILLS_DIR;
  }

  getSkillDownloaderPath(): string {
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
    const registry = this.#codeModeRegistry;
    if (registry === undefined) {
      // `supportsCodeMode` already told the caller this; the guard is what narrows the field.
      throw new Error('Code Mode needs a runtime that serves the sandbox bridge, and this one does not');
    }
    return new CloudflareComputerCodeModeTransport({
      registry,
      // A Code Mode call runs inside an exec, so it cannot be allowed to outlive one.
      maxRequestTimeoutSeconds: this.#defaultExecTimeoutSeconds,
    });
  }

  /**
   * Guards the calls that touch the workspace. The workspace is fixed by the session this provider
   * was built for, so an id from another session reads as gone and the caller makes a fresh sandbox
   * instead of reaching another one.
   */
  #assertOwnSandbox(sandboxId: string): void {
    if (sandboxId !== this.#sandboxId) {
      throw new SandboxNotAvailableError(sandboxId);
    }
  }
}
