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
  SandboxOfflineError,
  SandboxPathIsDirectoryError,
} from '@truefoundry/trueforge-core/core/sandbox/SandboxErrors';
import { parseSandboxId } from '@truefoundry/trueforge-core/core/sandbox/sandboxRef';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { AppendComputerAuditInput, ComputerAuditOp, IComputerStore } from '../db/computerStore';
import { newId } from '../utils/id';
import {
  FILE_CHUNK_BYTES,
  parseExecResult,
  parseFileGetResult,
  parseFilePutResult,
  type ComputerCapabilities,
  type RequestOutcome,
} from './protocol';
import { computerSessionDirectory, type ComputerRelayPort } from './service';

export const REMOTE_COMPUTER_PROVIDER_TYPE = 'remote-computer';

/**
 * The computer behind a persisted sandbox reference, for callers that have the reference but no
 * agent spec. The raw id is `<computer_id>/<session_id>`, and computer ids carry no slash.
 */
export function computerIdFromSandboxRef(sandboxId: string): string | undefined {
  const parsed = parseSandboxId(sandboxId);
  if (parsed.kind !== 'v1' || parsed.parts.providerType !== REMOTE_COMPUTER_PROVIDER_TYPE) {
    return undefined;
  }
  const slash = parsed.parts.rawId.indexOf('/');
  return slash <= 0 ? undefined : parsed.parts.rawId.slice(0, slash);
}

/** A reset relay rejects the RPC instead of answering; the caller must still read it as offline. */
const INTERRUPTED_MESSAGE = 'The connection to the computer was interrupted';

/** Client error codes the sandbox contract has its own classes for. Kept apart on purpose. */
const CLIENT_ERROR_NOT_FOUND = 'not_found';
const CLIENT_ERROR_IS_A_DIRECTORY = 'is_a_directory';

/** A user's machine is not built from an image, so there is nothing to wait for. */
const READY_BUILD: SandboxBuild = { status: 'ready', reason: null, metadata: null };

/** Commands are kept in the audit log at this size; the rest is a person's problem, not a record. */
const AUDIT_COMMAND_MAX_BYTES = 4096;

/**
 * Where paths point when the machine has never connected, so the getters stay total. Every command
 * fails offline in that state, and the next turn recomputes them from what `hello` reported.
 */
const UNKNOWN_HOME = '/nonexistent';

export interface RemoteComputerProviderOptions {
  relay: ComputerRelayPort;
  computerId: string;
  computerName: string;
  tenantId: string;
  sessionId: string;
  /** Null outside a turn, for example on the file-download route. */
  turnId: string | null;
  /** Null until the machine has reported a run-as user. */
  home: string | null;
  /** Null until the machine has said what it has; skills stay off in that case. */
  capabilities: ComputerCapabilities | null;
  defaultExecTimeoutSeconds: number;
  fileMaxBytesForDownload: number;
  store: Pick<IComputerStore, 'appendAudit'>;
  logger: Logger;
}

function truncateCommand(command: string): string {
  return command.length <= AUDIT_COMMAND_MAX_BYTES ? command : `${command.slice(0, AUDIT_COMMAND_MAX_BYTES)}…`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * A machine the tenant owns, reached through its relay. One provider serves one session on one
 * computer; the raw sandbox id is `<computer_id>/<session_id>` so the persisted reference carries
 * both and `existingSandboxIdForProvider` hands it back unchanged on the next turn.
 */
export class RemoteComputerProvider implements SandboxProvider {
  readonly type = REMOTE_COMPUTER_PROVIDER_TYPE;
  /** The Code Mode bridge needs container egress interception, which a user's machine has not got. */
  readonly supportsCodeMode = false;
  readonly #options: RemoteComputerProviderOptions;
  readonly #sandboxId: string;
  readonly #sessionDir: string;

  constructor(options: RemoteComputerProviderOptions) {
    this.#options = options;
    this.#sandboxId = `${options.computerId}/${options.sessionId}`;
    this.#sessionDir = computerSessionDirectory({
      home: options.home ?? UNKNOWN_HOME,
      sessionId: options.sessionId,
    });
  }

  /** Skills need the downloader's python3 and git; a machine that has neither cannot mount them. */
  get supportsSkills(): boolean {
    const capabilities = this.#options.capabilities;
    return capabilities !== null && capabilities.python3 && capabilities.git;
  }

  get computerName(): string {
    return this.#options.computerName;
  }

  buildImage(): Promise<SandboxBuild> {
    return Promise.resolve(READY_BUILD);
  }

  getImageBuildStatus(): Promise<SandboxBuild> {
    return Promise.resolve(READY_BUILD);
  }

  /**
   * Never fails: the id is derived, not allocated. Making the directory is best effort, because an
   * offline machine must surface at the first command with its own reason, not kill the turn here.
   */
  async createSandbox(): Promise<{ sandboxId: string }> {
    await this.#call({
      op: { op: 'exec', command: `mkdir -p '${this.#sessionDir}'`, cwd: null, env: {}, timeout_ms: 30_000 },
      timeoutMs: 30_000,
    });
    return { sandboxId: this.#sandboxId };
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    if (params.sandboxId !== this.#sandboxId) {
      return { success: false, error: `This computer does not serve sandbox ${params.sandboxId}` };
    }
    const timeoutSeconds = params.timeoutSeconds ?? this.#options.defaultExecTimeoutSeconds;
    const startedAt = Date.now();
    const outcome = await this.#call({
      op: {
        op: 'exec',
        command: params.command,
        cwd: params.cwd ?? this.#sessionDir,
        env: params.env ?? {},
        timeout_ms: timeoutSeconds * 1000,
      },
      timeoutMs: timeoutSeconds * 1000,
    });
    if (!outcome.ok) {
      await this.#audit({
        op: 'exec',
        command: params.command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        bytesOut: 0,
      });
      return { success: false, error: outcome.message };
    }
    const result = parseExecResult(outcome.result_json);
    if (result === undefined) {
      await this.#audit({
        op: 'exec',
        command: params.command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        bytesOut: 0,
      });
      return { success: false, error: `Computer ${this.#options.computerName} sent a reply this server cannot read` };
    }
    await this.#audit({
      op: 'exec',
      command: params.command,
      exitCode: result.exit_code,
      durationMs: result.duration_ms,
      bytesOut: result.bytes_total,
    });
    return { success: true, response: { exitCode: result.exit_code, result: result.stdout + result.stderr } };
  }

  getAdditionalInstructions(): string {
    return [
      `Commands run on ${this.#options.computerName}, a real machine someone owns and keeps.`,
      `Nothing is thrown away between sessions, and other sessions share the machine, so work inside ${this.#sessionDir} and leave the rest of the filesystem alone unless you are asked to change it.`,
      'Installing software, editing files outside the session directory and stopping services all affect the owner, so prefer the least invasive command that answers the question.',
    ].join(' ');
  }

  getToolResultDumpDir(): string {
    return `${this.#sessionDir}/.trueforge/tool-results`;
  }

  getGitCredentialsPath(): string {
    return `${this.#sessionDir}/.trueforge/git-credentials`;
  }

  getFileUploadsDir(): string {
    return `${this.#sessionDir}/uploads`;
  }

  getSkillsDir(): string {
    return `${this.#sessionDir}/.trueforge/skills`;
  }

  getSkillDownloaderPath(): string {
    return `${this.#sessionDir}/.trueforge/bin/skill_downloader.py`;
  }

  async downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer> {
    this.#assertOwnSandbox(params.sandboxId);
    const startedAt = Date.now();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let declaredDigest: string | null = null;
    for (;;) {
      const outcome = await this.#call({
        op: { op: 'file_get', path: params.path, offset: received, max_bytes: FILE_CHUNK_BYTES },
        timeoutMs: this.#options.defaultExecTimeoutSeconds * 1000,
      });
      if (!outcome.ok) {
        await this.#audit({
          op: 'file_get',
          command: params.path,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          bytesOut: received,
        });
        throw this.#fileFailure({ outcome, path: params.path });
      }
      const chunk = parseFileGetResult(outcome.result_json);
      if (chunk === undefined) {
        throw new SandboxOfflineError(`Computer ${this.#options.computerName} sent a reply this server cannot read`);
      }
      if (received === 0) {
        if (chunk.size > this.#options.fileMaxBytesForDownload) {
          throw new SandboxFileTooLargeError(params.path, chunk.size, this.#options.fileMaxBytesForDownload);
        }
        declaredDigest = chunk.sha256;
      }
      const bytes = fromBase64(chunk.data_b64);
      chunks.push(bytes);
      received += bytes.byteLength;
      if (received > this.#options.fileMaxBytesForDownload) {
        throw new SandboxFileTooLargeError(params.path, received, this.#options.fileMaxBytesForDownload);
      }
      if (chunk.eof) {
        break;
      }
      // A client that keeps answering with nothing would otherwise spin forever.
      if (bytes.byteLength === 0) {
        throw new SandboxOfflineError(`Computer ${this.#options.computerName} stopped sending ${params.path}`);
      }
    }
    const content = Buffer.concat(chunks);
    if (declaredDigest !== null) {
      const actual = await sha256Hex(content);
      if (actual !== declaredDigest) {
        throw new Error(`Download of ${params.path} was corrupted in transit`, {
          cause: new Error(`expected ${declaredDigest}, got ${actual}`),
        });
      }
    }
    await this.#audit({
      op: 'file_get',
      command: params.path,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      bytesOut: content.byteLength,
    });
    return content;
  }

  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    this.#assertOwnSandbox(params.sandboxId);
    const startedAt = Date.now();
    const transferId = newId();
    const digest = await sha256Hex(params.content);
    const total = params.content.byteLength;
    let sent = 0;
    let seq = 0;
    for (;;) {
      const slice = params.content.subarray(sent, Math.min(sent + FILE_CHUNK_BYTES, total));
      const final = sent + slice.byteLength >= total;
      const outcome = await this.#call({
        op: {
          op: 'file_put',
          transfer_id: transferId,
          path: params.remotePath,
          seq,
          data_b64: toBase64(slice),
          final,
          sha256: final ? digest : null,
        },
        timeoutMs: this.#options.defaultExecTimeoutSeconds * 1000,
      });
      if (!outcome.ok) {
        await this.#audit({
          op: 'file_put',
          command: params.remotePath,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          bytesOut: sent,
        });
        throw this.#fileFailure({ outcome, path: params.remotePath });
      }
      const reply = parseFilePutResult(outcome.result_json);
      if (reply === undefined) {
        throw new SandboxOfflineError(`Computer ${this.#options.computerName} sent a reply this server cannot read`);
      }
      sent += slice.byteLength;
      seq += 1;
      if (final) {
        if (reply.sha256 !== null && reply.sha256 !== digest) {
          throw new Error(`Upload of ${params.remotePath} was corrupted in transit`, {
            cause: new Error(`expected ${digest}, got ${reply.sha256}`),
          });
        }
        break;
      }
    }
    await this.#audit({
      op: 'file_put',
      command: params.remotePath,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      bytesOut: total,
    });
  }

  createCodeModeTransport(): CodeModeTransport {
    throw new Error('Code Mode needs a sandbox whose egress this server controls, and a real machine is not one');
  }

  /**
   * Every relay call goes through here. A reset relay rejects the RPC rather than answering, and the
   * spike measured that reaching the caller as a raw rejection, so it is mapped to the same shape an
   * offline machine produces instead of escaping as a 500.
   */
  async #call({ op, timeoutMs }: { op: Record<string, unknown>; timeoutMs: number }): Promise<RequestOutcome> {
    try {
      return await this.#options.relay.request({
        tenant_id: this.#options.tenantId,
        op_json: JSON.stringify(op),
        timeout_ms: timeoutMs,
      });
    } catch (error) {
      this.#options.logger.warn('Remote computer relay call was interrupted', {
        ...extractErrorLogFields(error),
        computer_id: this.#options.computerId,
      });
      return {
        ok: false,
        reason: 'interrupted',
        message: `${INTERRUPTED_MESSAGE} (${this.#options.computerName})`,
        last_seen_at: null,
        waited_ms: 0,
      };
    }
  }

  /**
   * Maps a failed file op onto the error classes the download route already answers. The relay
   * reports a client's `{code, message}` as `bad_request` with the code in front of the message.
   * A file that is too large never gets here: its size comes back with the first chunk.
   */
  #fileFailure({ outcome, path }: { outcome: Extract<RequestOutcome, { ok: false }>; path: string }): Error {
    if (outcome.reason !== 'bad_request') {
      return new SandboxOfflineError(outcome.message);
    }
    if (outcome.message.startsWith(`${CLIENT_ERROR_NOT_FOUND}:`)) {
      return new SandboxFileNotFoundError(path);
    }
    if (outcome.message.startsWith(`${CLIENT_ERROR_IS_A_DIRECTORY}:`)) {
      return new SandboxPathIsDirectoryError(path);
    }
    return new SandboxOfflineError(outcome.message);
  }

  #assertOwnSandbox(sandboxId: string): void {
    if (sandboxId !== this.#sandboxId) {
      throw new SandboxOfflineError(`This computer does not serve sandbox ${sandboxId}`);
    }
  }

  /** A record that could not be written must not fail the work it describes. */
  async #audit(input: {
    op: ComputerAuditOp;
    command: string;
    exitCode: number | null;
    durationMs: number;
    bytesOut: number;
  }): Promise<void> {
    const row: AppendComputerAuditInput = {
      id: newId(),
      computer_id: this.#options.computerId,
      tenant_id: this.#options.tenantId,
      session_id: this.#options.sessionId,
      turn_id: this.#options.turnId,
      op: input.op,
      command: truncateCommand(input.command),
      exit_code: input.exitCode,
      duration_ms: input.durationMs,
      bytes_out: input.bytesOut,
      created_at: new Date().toISOString(),
    };
    try {
      await this.#options.store.appendAudit(row);
    } catch (error) {
      this.#options.logger.warn('Could not record remote computer activity', {
        ...extractErrorLogFields(error),
        computer_id: this.#options.computerId,
      });
    }
  }
}
