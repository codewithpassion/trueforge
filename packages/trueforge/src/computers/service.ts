/**
 * Runtime-neutral access to remote computers. `undefined` everywhere it is threaded means the
 * runtime cannot serve them, which is how the Node build reports the feature off until phase 8c.
 */
import type { IComputerStore } from '../db/computerStore';
import type { ComputerRelayStatus, RelayRequestInput, RequestOutcome, TakeHumanLeaseOutcome } from './protocol';
import type { RateLimiter } from './rateLimit';

/** A session whose tip turn waits for a person to take over this computer's desktop. */
export interface TakeoverPointer {
  session_id: string;
  turn_id: string;
}

/** The relay calls the API and the provider make, narrowed so a test can stand one in. */
export interface ComputerRelayPort {
  request(input: RelayRequestInput): Promise<RequestOutcome>;
  /** Drops the desktop lease when this turn of this session holds it; a no-op otherwise. */
  releaseLease(input: { tenant_id: string; session_id: string; turn_id: string }): Promise<{ released: boolean }>;
  /** Notes that the session waits on a takeover since this turn, replacing its earlier pointer. */
  recordTakeoverPointer(input: TakeoverPointer & { tenant_id: string }): Promise<{ recorded: boolean }>;
  /** Forgets the session's pointer, but only while it still names this turn. */
  clearTakeoverPointer(input: TakeoverPointer & { tenant_id: string }): Promise<{ cleared: boolean }>;
  /** Oldest first. Pointers are only hints: the session tip decides whether one still waits. */
  listTakeoverPointers(input: { tenant_id: string }): Promise<TakeoverPointer[]>;
  /** A person takes the desktop, preempting any agent; waits for a previous person's clipboard clear. */
  takeHumanLease(input: { tenant_id: string; user_id: string }): Promise<TakeHumanLeaseOutcome>;
  /** Drops this person's control and clears both clipboard selections. A no-op when they do not hold it. */
  releaseHumanLease(input: {
    tenant_id: string;
    user_id: string;
  }): Promise<{ released: boolean; clipboard_cleared: boolean }>;
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
