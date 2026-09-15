import type { D1Database } from '@cloudflare/workers-types';
import type { Kysely } from 'kysely';
import type { AtomicRunner, BatchStatementResult, BatchWriteInput } from '../sqlite/atomic';
import type { Database } from '../sqlite/types';
import { createD1Db, D1Connection } from './client';

export class D1AtomicRunner implements AtomicRunner<Database> {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  /** A fresh `first-primary` session per group: sequential consistency, no snapshot. */
  readGroup<T>(callback: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    return callback(createD1Db({ queryable: this.#database.withSession('first-primary') }));
  }

  /** Runs on the executor's own session, so the batch sees the reads the caller made through it. */
  batchWrite({ executor, queries }: BatchWriteInput<Database>): Promise<readonly BatchStatementResult[]> {
    return executor.getExecutor().provideConnection(connection => {
      if (!(connection instanceof D1Connection)) {
        throw new Error('D1AtomicRunner.batchWrite requires an executor created by createD1Db');
      }
      return connection.batch(queries);
    });
  }
}
