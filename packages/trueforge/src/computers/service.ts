/**
 * Runtime-neutral access to remote computers. `undefined` everywhere it is threaded means the
 * runtime cannot serve them, which is how the Node build reports the feature off until phase 8c.
 */
import type { IComputerStore } from '../db/computerStore';
import type { ComputerRelayStatus, RequestOutcome } from './protocol';
import type { RateLimiter } from './rateLimit';

/** The relay calls the API and the provider make, narrowed so a test can stand one in. */
export interface ComputerRelayPort {
  request(input: { tenant_id: string; op_json: string; timeout_ms: number }): Promise<RequestOutcome>;
  /** Marks the machine revoked and closes its socket. Terminal for the client. */
  revoke(): Promise<{ closed: number }>;
  /** Closes the socket without revoking, so a re-enrolled machine can come back. */
  disconnect(): Promise<{ closed: number }>;
  /** Drops all relay state after the computer row is gone. */
  destroy(): Promise<void>;
  status(): Promise<ComputerRelayStatus>;
}

export interface ComputersService {
  readonly store: IComputerStore;
  /** Guards the two unauthenticated machine routes. Undefined leaves them unguarded. */
  readonly rateLimiter: RateLimiter | undefined;
  relay(computerId: string): ComputerRelayPort;
  /** Hands a WebSocket upgrade to the machine's relay, which owns the socket from then on. */
  relayFetch(input: { computerId: string; request: Request }): Promise<Response>;
}

/**
 * A session's directory on the machine. The root is the client's own `hello.workdir`: only the
 * machine knows where it keeps sessions, and a server that guesses writes commands for a path that
 * does not exist there.
 */
export function computerSessionDirectory(input: { workdir: string; sessionId: string }): string {
  return `${input.workdir}/${input.sessionId}`;
}

/**
 * Whether an absolute path stays inside a directory once `.` and `..` are resolved. A machine's own
 * symlinks can still point out of it, which only the client can see; it refuses its state directory
 * for exactly that reason.
 */
export function isInsideDirectory({ directory, path }: { directory: string; path: string }): boolean {
  if (!path.startsWith('/')) {
    return false;
  }
  const resolved: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const normalised = `/${resolved.join('/')}`;
  return normalised === directory || normalised.startsWith(`${directory}/`);
}
