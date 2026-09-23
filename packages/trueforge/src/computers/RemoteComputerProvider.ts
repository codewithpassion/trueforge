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
import { desktopFailureText } from './desktopTools';
import {
  DESKTOP_CLIPBOARD_TIMEOUT_MS,
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  desktopInputTimeoutMs,
  FILE_CHUNK_BYTES,
  offlineMessage,
  parseDesktopClipboardGetResult,
  parseDesktopOkResult,
  parseDesktopScreenshotResult,
  parseExecResult,
  parseFileGetResult,
  parseFilePutResult,
  stripControlCharacters,
  type ComputerCapabilities,
  type DesktopAction,
  type DesktopScreenshotResultPayload,
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
const CLIENT_ERROR_DESKTOP_UNAVAILABLE = 'desktop_unavailable';

/**
 * Why a desktop op did not happen. The first three are states the model can act on; `failed` is
 * everything else, with the relay's own wording.
 */
export type DesktopFailureCode = 'desktop_busy' | 'human_in_control' | 'desktop_unavailable' | 'failed';

export type DesktopCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: DesktopFailureCode; readonly message: string };

/** Both selections, so a paste with ctrl+v and one with a middle click see the same text. */
const DESKTOP_CLIPBOARD_SELECTIONS = ['clipboard', 'primary'] as const;

/** A user's machine is not built from an image, so there is nothing to wait for. */
const READY_BUILD: SandboxBuild = { status: 'ready', reason: null, metadata: null };

/** Commands are kept in the audit log at this size; the rest is a person's problem, not a record. */
const AUDIT_COMMAND_MAX_BYTES = 4096;

/**
 * What the path getters say before the machine has reported where it keeps sessions. Nothing is
 * ever sent while it is in use — every op answers offline — so it names the gap rather than
 * guessing at a directory on someone else's filesystem.
 */
const UNKNOWN_SESSION_DIR = '/nonexistent/session-directory-unknown';

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
  /** The machine's sessions root, or null until it has said what it is. */
  workdir: string | null;
  /** Null until the machine has said what it has; skills stay off in that case. */
  capabilities: ComputerCapabilities | null;
  /** The computer asks a person before each action; desktop input is withheld until that gate exists. */
  requireApproval: boolean;
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
  /** Null while the machine has not said where its sessions live; no op is sent in that state. */
  readonly #sessionDir: string | null;

  constructor(options: RemoteComputerProviderOptions) {
    this.#options = options;
    this.#sandboxId = `${options.computerId}/${options.sessionId}`;
    this.#sessionDir =
      options.workdir === null
        ? null
        : computerSessionDirectory({ workdir: options.workdir, sessionId: options.sessionId });
  }

  /** Reads as a path for prompt text; never reaches the machine, because nothing is sent. */
  #promptSessionDir(): string {
    return this.#sessionDir ?? UNKNOWN_SESSION_DIR;
  }

  /**
   * The machine has not reported its sessions root, so there is no directory to work in. It reads
   * as offline because that is what it is: the relay has no live hello from this computer.
   */
  #noSessionDirMessage(): string {
    return offlineMessage({ computerName: this.#options.computerName, lastSeenAt: null, now: Date.now() });
  }

  /** The machine's own verdict on whether the skill downloader can run: python3, git and pydantic. */
  get supportsSkills(): boolean {
    return this.#options.capabilities?.skills === true;
  }

  get computerName(): string {
    return this.#options.computerName;
  }

  /** The machine's own verdict that its desktop is up and drivable. */
  get supportsDesktop(): boolean {
    return this.#options.capabilities?.desktop === true;
  }

  get desktopUnavailableReason(): string | null {
    const reason = this.#options.capabilities?.desktop_unavailable_reason ?? null;
    return reason === null ? null : stripControlCharacters(reason);
  }

  get requiresApproval(): boolean {
    return this.#options.requireApproval;
  }

  async desktopScreenshot(): Promise<DesktopCallResult<DesktopScreenshotResultPayload>> {
    const outcome = await this.#call({
      op: { op: 'desktop_screenshot', quality: null },
      timeoutMs: DESKTOP_SCREENSHOT_TIMEOUT_MS,
    });
    return this.#desktopResult({ outcome, parse: parseDesktopScreenshotResult });
  }

  async desktopInput(actions: readonly DesktopAction[]): Promise<DesktopCallResult<{ ok: true }>> {
    const outcome = await this.#call({
      op: { op: 'desktop_input', actions },
      timeoutMs: desktopInputTimeoutMs(actions),
    });
    return this.#desktopResult({ outcome, parse: parseDesktopOkResult });
  }

  async desktopClipboardGet(): Promise<DesktopCallResult<{ text: string }>> {
    const outcome = await this.#call({ op: { op: 'desktop_clipboard_get' }, timeoutMs: DESKTOP_CLIPBOARD_TIMEOUT_MS });
    return this.#desktopResult({ outcome, parse: parseDesktopClipboardGetResult });
  }

  async desktopClipboardSet(text: string): Promise<DesktopCallResult<{ ok: true }>> {
    const outcome = await this.#call({
      op: { op: 'desktop_clipboard_set', text, selections: DESKTOP_CLIPBOARD_SELECTIONS },
      timeoutMs: DESKTOP_CLIPBOARD_TIMEOUT_MS,
    });
    return this.#desktopResult({ outcome, parse: parseDesktopOkResult });
  }

  /**
   * The relay refuses on the lease itself; a daemon whose desktop went down answers with its own
   * `desktop_unavailable` code, which arrives as `bad_request` with the code in front.
   */
  #desktopResult<T>({
    outcome,
    parse,
  }: {
    outcome: RequestOutcome;
    parse: (json: string) => T | undefined;
  }): DesktopCallResult<T> {
    if (outcome.ok) {
      const value = parse(outcome.result_json);
      return value === undefined
        ? {
            ok: false,
            code: 'failed',
            message: `Computer ${this.#options.computerName} sent a reply this server cannot read`,
          }
        : { ok: true, value };
    }
    switch (outcome.reason) {
      case 'desktop_busy':
      case 'human_in_control':
      case 'desktop_unavailable':
        return { ok: false, code: outcome.reason, message: outcome.message };
      case 'bad_request':
        if (outcome.message.startsWith(`${CLIENT_ERROR_DESKTOP_UNAVAILABLE}:`)) {
          return { ok: false, code: 'desktop_unavailable', message: outcome.message };
        }
        return { ok: false, code: 'failed', message: outcome.message };
      default:
        return { ok: false, code: 'failed', message: outcome.message };
    }
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
    const sessionDir = this.#sessionDir;
    if (sessionDir === null) {
      await this.#audit({
        op: 'exec',
        command: 'mkdir -p <session directory>',
        exitCode: null,
        durationMs: 0,
        bytesOut: 0,
        outcome: 'offline',
      });
      return { sandboxId: this.#sandboxId };
    }
    // The path is built from what the machine reported, so it is quoted rather than interpolated.
    const command = `mkdir -p ${shellEscape(sessionDir)}`;
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
    const sessionDir = this.#sessionDir;
    if (sessionDir === null) {
      await this.#audit({
        op: 'exec',
        command: params.command,
        exitCode: null,
        durationMs: 0,
        bytesOut: 0,
        outcome: 'offline',
      });
      return { success: false, error: this.#noSessionDirMessage() };
    }
    const timeoutSeconds = params.timeoutSeconds ?? this.#options.defaultExecTimeoutSeconds;
    const startedAt = Date.now();
    const outcome = await this.#call({
      op: {
        op: 'exec',
        command: params.command,
        cwd: params.cwd ?? sessionDir,
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
      // Worded like the desktop tools' refusal, so the model stops rather than retrying the command.
      const error =
        outcome.reason === 'human_in_control'
          ? desktopFailureText({ code: 'human_in_control', message: outcome.message })
          : outcome.message;
      return { success: false, error };
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
      `Nothing is thrown away between sessions, and other sessions share the machine, so work inside ${this.#promptSessionDir()} and leave the rest of the filesystem alone unless you are asked to change it.`,
      'Installing software, editing files outside the session directory and stopping services all affect the owner, so prefer the least invasive command that answers the question.',
    ].join(' ');
  }

  getToolResultDumpDir(): string {
    return `${this.#promptSessionDir()}/.trueforge/tool-results`;
  }

  getGitCredentialsPath(): string {
    return `${this.#promptSessionDir()}/.trueforge/git-credentials`;
  }

  getFileUploadsDir(): string {
    return `${this.#promptSessionDir()}/uploads`;
  }

  getSkillsDir(): string {
    return `${this.#promptSessionDir()}/.trueforge/skills`;
  }

  getSkillDownloaderPath(): string {
    return `${this.#promptSessionDir()}/.trueforge/bin/skill_downloader.py`;
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
        principal: { kind: 'agent', session_id: this.#options.sessionId },
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
    const sessionDir = this.#sessionDir;
    if (sessionDir === null) {
      throw new SandboxOfflineError(this.#noSessionDirMessage());
    }
    if (!isInsideDirectory({ directory: sessionDir, path })) {
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
