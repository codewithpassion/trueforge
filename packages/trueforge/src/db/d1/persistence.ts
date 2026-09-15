import type { D1Database } from '@cloudflare/workers-types';
import type { Kysely } from 'kysely';
import { createSqliteStores } from '../sqlite/stores';
import type { Database } from '../sqlite/types';
import type { WithTransaction } from '../transaction';
import { D1AtomicRunner } from './atomic';
import { createD1Db } from './client';

/**
 * SQLite-dialect stores over D1. `withTransaction` only pins the callback to one `first-primary`
 * session (sequential reads); it is not atomic, so multi-statement writes must use batchWrite.
 */
export function createD1Persistence({ database, mcpClientName }: { database: D1Database; mcpClientName: string }) {
  const withTransaction: WithTransaction<Kysely<Database>> = callback =>
    callback(createD1Db({ queryable: database.withSession('first-primary') }));
  return {
    withTransaction,
    ...createSqliteStores({
      db: createD1Db({ queryable: database }),
      atomic: new D1AtomicRunner(database),
      mcpClientName,
    }),
  };
}
