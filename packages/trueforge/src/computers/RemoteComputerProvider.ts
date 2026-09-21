import type { CodeModeTransport } from '@truefoundry/trueforge-core/core/sandbox/codeMode/CodeModeTransport';
import {
  shellEscape,
  type ExecResult,
  type SandboxBuild,
  type SandboxExecParams,
  type SandboxProvider,
} from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxOfflineError,
  SandboxPathIsDirectoryError,
  SandboxPathOutsideSessionError,
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
  stripControlCharacters,
  type ComputerCapabilities,
  type RequestOutcome,
} from './protocol';
import { computerSessionDirectory, isInsideDirectory, type ComputerRelayPort } from './service';

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
const INTERRUPTED_MESSAGE =
  'The connection to the computer was interrupted. The command may still be running there; it is not retried, ' +
  'and a cancel is sent for it when the machine reconnects. Ask again if you need the result.';

/**
 * Client error codes the sandbox contract has its own class for. The code is an open string — the
 * client adds to it — so anything not listed here keeps its own wording rather than being forced
 * into a class that would misdescribe it.
 */
const CLIENT_ERROR_NOT_FOUND = 'not_found';
const CLIENT_ERROR_IS_A_DIRECTORY = 'is_a_directory';
const CLIENT_ERROR_NOT_A_REGULAR_FILE = 'not_a_regular_file';
const CLIENT_ERROR_TOO_LARGE = 'too_large';

/** A user's machine is not built from an image, so there is nothing to wait for. */
const READY_BUILD: SandboxBuild = { status: 'ready', reason: null, metadata: null };

/** Commands are kept in the audit log at this size; the rest is a person's problem, not a record. */
const AUDIT_COMMAND_MAX_BYTES = 4096;

/**
 * Where paths point when the machine has never connected, so the getters stay total. Every command
 * fails offline in that state, and the next turn recomputes them from what `hello` reported.
 */
const UNKNOWN_HOME = '/nonexistent';

/** Making the session directory is setup, not the agent's command; it gets its own short deadline. */
const SETUP_TIMEOUT_MS = 30_000;

/**
 * What a command's output may contribute to the model's context. The client caps itself, but a
 * client is not trusted, and an uncapped string fails twice: once on the way in and once in the
 * model. Matches the built-in sandbox's own ceiling.
 */
const EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;

const OUTPUT_ELISION = '\n[... output truncated by the server ...]\n';

function capOutput(value: string): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= EXEC_OUTPUT_MAX_BYTES) {
    return value;
  }
  // Head and tail, because a build's reason for failing is at the end.
  const half = Math.floor((EXEC_OUTPUT_MAX_BYTES - OUTPUT_ELISION.length) / 2);
  const decoder = new TextDecoder();
  const head = decoder.decode(encoded.subarray(0, half));
  const tail = decoder.decode(encoded.subarray(encoded.byteLength - half));
  return head + OUTPUT_ELISION + tail;
}

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

/** Truncates by bytes, not UTF-16 units, and never mid-code-point: the column limit is in bytes. */
function truncateCommand(command: string): string {
  const encoded = new TextEncoder().encode(command);
  if (encoded.byteLength <= AUDIT_COMMAND_MAX_BYTES) {
    return command;
  }
  const head = new TextDecoder().decode(encoded.subarray(0, AUDIT_COMMAND_MAX_BYTES));
  // A split code point decodes to U+FFFD; dropping it keeps the text honest.
  return `${head.replace(/\uFFFD$/, '')}…`;
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
    // The path is built from what the machine reported, so it is quoted rather than interpolated.
    const command = `mkdir -p ${shellEscape(this.#sessionDir)}`;
    const startedAt = Date.now();
    const outcome = await this.#call({
      op: { op: 'exec', command, cwd: null, env: {}, timeout_ms: SETUP_TIMEOUT_MS },
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    await this.#audit({
      op: 'exec',
      command,
      exitCode: outcome.ok ? (parseExecResult(outcome.result_json)?.exit_code ?? null) : null,
      durationMs: Date.now() - startedAt,
      bytesOut: 0,
      outcome: outcome.ok ? 'ok' : outcome.reason,
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
        outcome: outcome.reason,
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
        outcome: 'unreadable_reply',
      });
      return { success: false, error: `Computer ${this.#options.computerName} sent a reply this server cannot read` };
    }
    await this.#audit({
      op: 'exec',
      command: params.command,
      exitCode: result.exit_code,
      durationMs: result.duration_ms,
      bytesOut: result.bytes_total,
      outcome: 'ok',
    });
    // The client caps its own output, but a hostile one need not, and this string goes straight
    // into the model's context.
    const combined = capOutput(result.stdout + result.stderr);
    return { success: true, response: { exitCode: result.exit_code, result: combined } };
  }

  getAdditionalInstructions(): string {
    return [
      `Commands run on ${stripControlCharacters(this.#options.computerName)}, a real machine someone owns and keeps.`,
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
    this.#assertInsideSession(params.path);
    const startedAt = Date.now();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let outcomeLabel = 'failed';
    try {
      let declaredDigest: string | null = null;
      for (;;) {
        const outcome = await this.#call({
          op: { op: 'file_get', path: params.path, offset: received, max_bytes: FILE_CHUNK_BYTES },
          timeoutMs: this.#options.defaultExecTimeoutSeconds * 1000,
        });
        if (!outcome.ok) {
          outcomeLabel = outcome.reason;
          throw this.#fileFailure({ outcome, path: params.path });
        }
        const chunk = parseFileGetResult(outcome.result_json);
        if (chunk === undefined) {
          outcomeLabel = 'unreadable_reply';
          throw new SandboxOfflineError(`Computer ${this.#options.computerName} sent a reply this server cannot read`);
        }
        if (received === 0) {
          if (chunk.size > this.#options.fileMaxBytesForDownload) {
            outcomeLabel = 'too_large';
            throw new SandboxFileTooLargeError(params.path, chunk.size, this.#options.fileMaxBytesForDownload);
          }
          declaredDigest = chunk.sha256;
        }
        const bytes = fromBase64(chunk.data_b64);
        chunks.push(bytes);
        received += bytes.byteLength;
        if (received > this.#options.fileMaxBytesForDownload) {
          outcomeLabel = 'too_large';
          throw new SandboxFileTooLargeError(params.path, received, this.#options.fileMaxBytesForDownload);
        }
        if (chunk.eof) {
          break;
        }
        // A client that keeps answering with nothing would otherwise spin forever.
        if (bytes.byteLength === 0) {
          outcomeLabel = 'stalled';
          throw new SandboxOfflineError(`Computer ${this.#options.computerName} stopped sending ${params.path}`);
        }
      }
      const content = Buffer.concat(chunks);
      if (declaredDigest !== null) {
        const actual = await sha256Hex(content);
        if (actual !== declaredDigest) {
          outcomeLabel = 'digest_mismatch';
          throw new Error(`Download of ${params.path} was corrupted in transit`, {
            cause: new Error(`expected ${declaredDigest}, got ${actual}`),
          });
        }
      }
      outcomeLabel = 'ok';
      return content;
    } finally {
      // Every path writes a row, refusals included: a read that was attempted and denied is
      // exactly what someone reviewing a machine's activity needs to see.
      await this.#audit({
        op: 'file_get',
        command: params.path,
        exitCode: outcomeLabel === 'ok' ? 0 : null,
        durationMs: Date.now() - startedAt,
        bytesOut: received,
        outcome: outcomeLabel,
      });
    }
  }

  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    this.#assertOwnSandbox(params.sandboxId);
    this.#assertInsideSession(params.remotePath);
    const startedAt = Date.now();
    const transferId = newId();
    const total = params.content.byteLength;
    let sent = 0;
    let outcomeLabel = 'failed';
    try {
      const digest = await sha256Hex(params.content);
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
          outcomeLabel = outcome.reason;
          throw this.#fileFailure({ outcome, path: params.remotePath });
        }
        const reply = parseFilePutResult(outcome.result_json);
        if (reply === undefined) {
          outcomeLabel = 'unreadable_reply';
          throw new SandboxOfflineError(`Computer ${this.#options.computerName} sent a reply this server cannot read`);
        }
        sent += slice.byteLength;
        seq += 1;
        if (final) {
          if (reply.sha256 !== null && reply.sha256 !== digest) {
            outcomeLabel = 'digest_mismatch';
            throw new Error(`Upload of ${params.remotePath} was corrupted in transit`, {
              cause: new Error(`expected ${digest}, got ${reply.sha256}`),
            });
          }
          break;
        }
      }
      outcomeLabel = 'ok';
    } finally {
      await this.#audit({
        op: 'file_put',
        command: params.remotePath,
        exitCode: outcomeLabel === 'ok' ? 0 : null,
        durationMs: Date.now() - startedAt,
        bytesOut: sent,
        outcome: outcomeLabel,
      });
    }
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
   * A code with no matching class keeps its own text: calling a refused path or a denied read
   * "offline" would send the caller looking at the network instead of at what it asked for.
   */
  #fileFailure({ outcome, path }: { outcome: Extract<RequestOutcome, { ok: false }>; path: string }): Error {
    // Offline, timed out, revoked, replaced, forbidden: the machine never answered.
    if (outcome.reason !== 'bad_request') {
      return new SandboxOfflineError(outcome.message);
    }
    const code = outcome.message.slice(0, Math.max(0, outcome.message.indexOf(':')));
    switch (code) {
      case CLIENT_ERROR_NOT_FOUND:
        return new SandboxFileNotFoundError(path);
      case CLIENT_ERROR_IS_A_DIRECTORY:
      case CLIENT_ERROR_NOT_A_REGULAR_FILE:
        return new SandboxPathIsDirectoryError(path);
      case CLIENT_ERROR_TOO_LARGE:
        return new SandboxFileTooLargeError(
          path,
          this.#options.fileMaxBytesForDownload,
          this.#options.fileMaxBytesForDownload,
        );
      default:
        return new Error(`Computer ${this.#options.computerName} refused ${path}: ${outcome.message}`);
    }
  }

  #assertOwnSandbox(sandboxId: string): void {
    if (sandboxId !== this.#sandboxId) {
      throw new SandboxOfflineError(`This computer does not serve sandbox ${sandboxId}`);
    }
  }

  /**
   * File operations stay inside this session's directory. `exec` deliberately sees the whole
   * machine, but a file transfer is reachable from the download route by anyone who owns the
   * session, and an unbounded read would hand over the client's own credential file — which is
   * enough to connect as the computer and collect other sessions' commands.
   */
  #assertInsideSession(path: string): void {
    if (!isInsideDirectory({ directory: this.#sessionDir, path })) {
      throw new SandboxPathOutsideSessionError(path);
    }
  }

  /** A record that could not be written must not fail the work it describes. */
  async #audit(input: {
    op: ComputerAuditOp;
    command: string;
    exitCode: number | null;
    durationMs: number;
    bytesOut: number;
    /** `ok`, or why it did not finish. Recorded so a refusal is as visible as a success. */
    outcome: string;
  }): Promise<void> {
    const row: AppendComputerAuditInput = {
      id: newId(),
      computer_id: this.#options.computerId,
      computer_name: this.#options.computerName,
      tenant_id: this.#options.tenantId,
      outcome: input.outcome,
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
