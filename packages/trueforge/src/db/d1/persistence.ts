import type { D1Database } from '@cloudflare/workers-types';
import type { Kysely } from 'kysely';
import { createSqliteStores } from '../sqlite/stores';
import type { Database } from '../sqlite/types';
import type { WithTransaction } from '../transaction';
import { D1AtomicRunner } from './atomic';
import { createD1Db, type D1StatementCounter } from './client';

/**
 * SQLite-dialect stores over D1. `withTransaction` only pins the callback to one `first-primary`
 * session (sequential reads); it is not atomic, so multi-statement writes must use batchWrite.
 */
export function createD1Persistence({
  database,
  mcpClientName,
  onStatements,
}: {
  database: D1Database;
  mcpClientName: string;
  /** Sees every statement these stores send, including batch members. */
  onStatements?: D1StatementCounter | undefined;
}) {
  const withTransaction: WithTransaction<Kysely<Database>> = callback =>
    callback(createD1Db({ queryable: database.withSession('first-primary'), onStatements }));
  return {
    withTransaction,
    ...createSqliteStores({
      db: createD1Db({ queryable: database, onStatements }),
      atomic: new D1AtomicRunner(database, onStatements),
      mcpClientName,
    }),
  };
}
