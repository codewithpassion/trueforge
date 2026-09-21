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

/**
 * The D1-backed rows on their own, for the relay, which has no namespace to hand out.
 *
 * Reads are pinned to the primary. Every other store here takes replica reads, but this one
 * answers "may this agent use this machine", and an authorization decision must not be allowed to
 * read a grant that has since been taken away. It also makes the read after `PUT .../agents`
 * see that write, which a replica need not.
 */
export function workersComputerStore(env: Pick<Env, 'DB'>): SqliteComputerStore {
  return new SqliteComputerStore(
    createD1Db({ queryable: env.DB.withSession('first-primary') }),
    new D1AtomicRunner(env.DB),
  );
}

export function workersComputersService(
  env: Pick<Env, 'DB' | 'REMOTE_COMPUTER_DO' | 'RATE_LIMIT_DO'>,
): ComputersService {
  const store = workersComputerStore(env);
  const stubFor = (computerId: string) => env.REMOTE_COMPUTER_DO.get(env.REMOTE_COMPUTER_DO.idFromName(computerId));
  return {
    store,
    rateLimiter: {
      take: ({ key, limit, windowMs }) =>
        env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(key)).take({ limit, windowMs }),
    },
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
