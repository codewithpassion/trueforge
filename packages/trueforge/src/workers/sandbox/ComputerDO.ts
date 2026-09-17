import { Workspace } from '@cloudflare/computer';
import { CloudflareContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import { DurableObject } from 'cloudflare:workers';
import configuration from '../../config';
import type { Env } from '../env';
import { createConsoleLogger } from '../logger';
import { workspaceStorage } from './workspaceStorage';

/** Binding name the container egress proxy resolves back to this class. */
export const COMPUTER_DO_BINDING = 'COMPUTER_DO';

/**
 * Combined stdout and stderr kept from one command. A serialized RPC message caps at 32 MiB, and an
 * uncapped result would fail opaquely there and then again on the way into the model's context.
 */
export const COMPUTER_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;

/** Idle time before the platform stops the container; a later command starts a fresh one. */
const CONTAINER_INACTIVITY_TIMEOUT_MS = 10 * 60_000;

export interface ComputerExecRequest {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/**
 * Plain exec facts. Sandbox error classes do not survive Workers RPC, so the provider — not this
 * object — turns these into `ExecResult`.
 */
export interface ComputerExecOutcome {
  /** Derived from `exitCode` alone: `failed` covers every non-zero exit, including an ordinary one. */
  status: 'completed' | 'failed' | 'cancelled';
  /** Negative when no exit event arrived, which is the only sign that the command never launched. */
  exitCode: number;
  /** stdout followed by stderr, which is what the sandbox contract reports as `result`. */
  output: string;
  /** `output` was cut at COMPUTER_EXEC_OUTPUT_MAX_BYTES; the command itself still ran to completion. */
  outputTruncated: boolean;
  /** The command finished but its writes had not reached the workspace store yet. */
  syncPending: boolean;
  syncError: string | undefined;
}

/** Keeps the head of the output, which is where a command puts what matters most often. */
export function capOutput(output: string): { output: string; outputTruncated: boolean } {
  const encoded = new TextEncoder().encode(output);
  if (encoded.byteLength <= COMPUTER_EXEC_OUTPUT_MAX_BYTES) {
    return { output, outputTruncated: false };
  }
  // `fatal: false` keeps a split multi-byte character at the cut from throwing.
  const kept = new TextDecoder().decode(encoded.subarray(0, COMPUTER_EXEC_OUTPUT_MAX_BYTES));
  return {
    output: `${kept}\n[output truncated at ${String(COMPUTER_EXEC_OUTPUT_MAX_BYTES)} bytes of ${String(encoded.byteLength)}; write it to a file under /workspace and read the part you need]`,
    outputTruncated: true,
  };
}

export type ComputerReadOutcome =
  | { ok: true; size: number; content: ReadableStream<Uint8Array> }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'is_directory' }
  | { ok: false; reason: 'too_large'; size: number };

/** Workspace filesystem errors carry a POSIX `code`; every other failure must keep propagating. */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** What `CloudflareComputerProvider` calls; everything crossing it is serializable over Workers RPC. */
export interface ComputerWorkspace {
  execCommand(request: ComputerExecRequest): Promise<ComputerExecOutcome>;
  writeFile(request: { path: string; content: Uint8Array }): Promise<void>;
  readFile(request: { path: string; maxBytes: number }): Promise<ComputerReadOutcome>;
}

export class ComputerDO extends withWorkspaceContainer(class extends DurableObject {}) implements ComputerWorkspace {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  readonly #logger = createConsoleLogger({ level: configuration.LOG_LEVEL, bindings: { component: 'ComputerDO' } });
  #inactivityTimeoutSet = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#backend = new CloudflareContainerBackend({
      container: () => this,
      workspace: { binding: COMPUTER_DO_BINDING, id: ctx.id.toString() },
      // Every outbound request the container makes arrives at the gateway with its original URL, so
      // Code Mode gets an address inside the Worker and the rest of egress stays reviewable.
      egress: { mode: 'http-gateway', gateway: ctx.exports.SandboxEgressGateway },
    });
    this.#workspace = new Workspace({
      storage: workspaceStorage(ctx.storage),
      backends: [this.#backend],
    });
  }

  /** `computerd` dials back out to `/api`; the egress proxy routes that upgrade here. */
  override fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }

  async execCommand(request: ComputerExecRequest): Promise<ComputerExecOutcome> {
    using handle = await this.#workspace.runtime.exec(request.command, {
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      encoding: 'utf8',
    });
    const result = await handle.result();
    await this.#keepContainerWarmBriefly();
    const capped = capOutput(result.stdout + result.stderr);
    if (capped.outputTruncated) {
      this.#logger.warn('Sandbox command output was truncated', {
        limit: COMPUTER_EXEC_OUTPUT_MAX_BYTES,
      });
    }
    return {
      status: result.status,
      exitCode: result.exitCode,
      ...capped,
      syncPending: result.sync.status === 'pending',
      syncError: result.sync.status === 'pending' ? result.sync.error : undefined,
    };
  }

  /**
   * Applied once the container is attached, since the platform rejects it before a start. Best
   * effort: a container that stays on its default lifetime is not worth failing a command over.
   */
  async #keepContainerWarmBriefly(): Promise<void> {
    if (this.#inactivityTimeoutSet) {
      return;
    }
    this.#inactivityTimeoutSet = true;
    try {
      await this.getWorkspaceContainer().setInactivityTimeout(CONTAINER_INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      this.#inactivityTimeoutSet = false;
      this.#logger.warn('Could not set the sandbox container inactivity timeout', extractErrorLogFields(error));
    }
  }

  async writeFile(request: { path: string; content: Uint8Array }): Promise<void> {
    const separator = request.path.lastIndexOf('/');
    if (separator > 0) {
      await this.#workspace.fs.mkdir(request.path.slice(0, separator), { recursive: true });
    }
    await this.#workspace.fs.writeFile(request.path, request.content);
  }

  async readFile(request: { path: string; maxBytes: number }): Promise<ComputerReadOutcome> {
    const stat = await this.#workspace.fs.lstat(request.path).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    });
    if (stat === undefined) {
      return { ok: false, reason: 'not_found' };
    }
    if (stat.isDirectory) {
      return { ok: false, reason: 'is_directory' };
    }
    if (stat.size > request.maxBytes) {
      return { ok: false, reason: 'too_large', size: stat.size };
    }
    return { ok: true, size: stat.size, content: await this.#workspace.fs.readFile(request.path) };
  }
}
