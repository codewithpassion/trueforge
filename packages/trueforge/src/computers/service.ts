/**
 * Runtime-neutral access to remote computers. `undefined` everywhere it is threaded means the
 * runtime cannot serve them, which is how the Node build reports the feature off until phase 8c.
 */
import type { IComputerStore } from '../db/computerStore';
import type { ComputerRelayStatus, RequestOutcome } from './protocol';

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
  relay(computerId: string): ComputerRelayPort;
  /** Hands a WebSocket upgrade to the machine's relay, which owns the socket from then on. */
  relayFetch(input: { computerId: string; request: Request }): Promise<Response>;
}

/** Where a machine's per-session directories live, derived from what `hello` reported. */
export function computerHomeDirectory(input: { os: string | null; runAsUser: string | null }): string | null {
  const { os, runAsUser } = input;
  if (runAsUser === null || runAsUser === '') {
    return null;
  }
  if (runAsUser === 'root') {
    return os === 'darwin' ? '/var/root' : '/root';
  }
  return os === 'darwin' ? `/Users/${runAsUser}` : `/home/${runAsUser}`;
}

/**
 * The client's state root. Phase 8b derives it from the run-as user because the frozen v1 `hello`
 * carries no home path; a machine with a non-standard `$HOME` needs `home` in protocol v2.
 */
export function computerStateRoot(home: string): string {
  return `${home}/.trueforge`;
}

export function computerSessionDirectory(input: { home: string; sessionId: string }): string {
  return `${computerStateRoot(input.home)}/sessions/${input.sessionId}`;
}
