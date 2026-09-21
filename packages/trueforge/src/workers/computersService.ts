/**
 * Remote computers on Workers: D1 rows plus one relay Durable Object per machine. The stub's
 * methods are forwarded explicitly rather than handed over as-is, so the port stays a plain
 * contract a test can stand in for.
 */
import type { ComputersService } from '../computers/service';
import { D1AtomicRunner } from '../db/d1/atomic';
import { createD1Db } from '../db/d1/client';
import { SqliteComputerStore } from '../db/sqlite/computer-store/SqliteComputerStore';
import type { Env } from './env';

/** The D1-backed rows on their own, for the relay, which has no namespace to hand out. */
export function workersComputerStore(env: Pick<Env, 'DB'>): SqliteComputerStore {
  return new SqliteComputerStore(createD1Db({ queryable: env.DB }), new D1AtomicRunner(env.DB));
}

export function workersComputersService(env: Pick<Env, 'DB' | 'REMOTE_COMPUTER_DO'>): ComputersService {
  const store = workersComputerStore(env);
  const stubFor = (computerId: string) => env.REMOTE_COMPUTER_DO.get(env.REMOTE_COMPUTER_DO.idFromName(computerId));
  return {
    store,
    relayFetch: ({ computerId, request }) => stubFor(computerId).fetch(request),
    relay: computerId => {
      const stub = stubFor(computerId);
      return {
        request: input => stub.request(input),
        revoke: () => stub.revoke(),
        disconnect: () => stub.disconnect(),
        destroy: () => stub.destroy(),
        status: () => stub.status(),
      };
    },
  };
}
