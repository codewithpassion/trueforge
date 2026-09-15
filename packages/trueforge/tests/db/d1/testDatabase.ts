import { applyD1Migrations, reset } from 'cloudflare:test';
import type { Kysely } from 'kysely';

import { D1AtomicRunner } from '../../../src/db/d1/atomic';
import { createD1Db } from '../../../src/db/d1/client';
import type { Database } from '../../../src/db/sqlite/types';
import type { WithTransaction } from '../../../src/db/transaction';

export interface D1TestDatabase {
  db: Kysely<Database>;
  atomic: D1AtomicRunner;
  withTransaction: WithTransaction<Kysely<Database>>;
}

/**
 * Empties the D1 binding, applies migrations/d1, and binds a fresh first-primary session.
 * Test files pass the pool's `env` so the harness has no module-level binding import.
 */
export async function createD1TestDatabase(bindings: Cloudflare.Env): Promise<D1TestDatabase> {
  await reset();
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  return {
    db: createD1Db({ queryable: bindings.DB.withSession('first-primary') }),
    atomic: new D1AtomicRunner(bindings.DB),
    withTransaction: callback => callback(createD1Db({ queryable: bindings.DB.withSession('first-primary') })),
  };
}
