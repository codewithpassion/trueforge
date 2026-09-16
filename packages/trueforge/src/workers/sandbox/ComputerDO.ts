import { Workspace } from '@cloudflare/computer';
import { CloudflareContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { workspaceStorage } from './workspaceStorage';

/** Binding name the container egress proxy resolves back to this class. */
export const COMPUTER_DO_BINDING = 'COMPUTER_DO';

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
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number;
  /** stdout followed by stderr, which is what the sandbox contract reports as `result`. */
  output: string;
  /** The command finished but its writes had not reached the workspace store yet. */
  syncPending: boolean;
  syncError: string | undefined;
}

export type ComputerReadOutcome =
  | { ok: true; size: number; content: ReadableStream<Uint8Array> }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'is_directory' }
  | { ok: false; reason: 'too_large'; size: number };

/** What `CloudflareComputerProvider` calls; everything crossing it is serializable over Workers RPC. */
export interface ComputerWorkspace {
  execCommand(request: ComputerExecRequest): Promise<ComputerExecOutcome>;
  writeFile(request: { path: string; content: Uint8Array }): Promise<void>;
  readFile(request: { path: string; maxBytes: number }): Promise<ComputerReadOutcome>;
}

export class ComputerDO extends withWorkspaceContainer(class extends DurableObject {}) implements ComputerWorkspace {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#backend = new CloudflareContainerBackend({
      container: () => this,
      workspace: { binding: COMPUTER_DO_BINDING, id: ctx.id.toString() },
      // Phase 7d replaces this with an `http-gateway` allowlist.
      egress: { mode: 'direct' },
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
    return {
      status: result.status,
      exitCode: result.exitCode,
      output: result.stdout + result.stderr,
      syncPending: result.sync.status === 'pending',
      syncError: result.sync.status === 'pending' ? result.sync.error : undefined,
    };
  }

  async writeFile(request: { path: string; content: Uint8Array }): Promise<void> {
    const separator = request.path.lastIndexOf('/');
    if (separator > 0) {
      await this.#workspace.fs.mkdir(request.path.slice(0, separator), { recursive: true });
    }
    await this.#workspace.fs.writeFile(request.path, request.content);
  }

  async readFile(request: { path: string; maxBytes: number }): Promise<ComputerReadOutcome> {
    const stat = await this.#workspace.fs.lstat(request.path).catch(() => undefined);
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
