import Database from 'better-sqlite3';
import {
  CompiledQuery,
  Kysely,
  ParseJSONResultsPlugin,
  SqliteAdapter,
  SqliteDriver,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryCompiler,
  type TransactionSettings,
} from 'kysely';

import type { AtomicRunner, BatchStatementResult, BatchWriteInput } from './atomic';
import { shouldParseJsonResultColumn } from './jsonColumns';
import type { Database as Schema } from './types';

/**
 * Wraps SqliteDriver and maps Kysely access mode onto SQLite begin kinds:
 * - omit / `read only` → deferred BEGIN (matches Postgres default feel)
 * - `read write` → BEGIN IMMEDIATE (RESERVED write lock)
 *
 * Stock SqliteDriver.d.ts omits `settings` on beginTransaction; compose instead of override.
 */
class ImmediateSqliteDriver implements Driver {
  readonly #inner: SqliteDriver;

  constructor(database: Database.Database) {
    this.#inner = new SqliteDriver({ database });
  }

  init(): Promise<void> {
    return this.#inner.init();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return this.#inner.acquireConnection();
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const begin = settings.accessMode === 'read write' ? 'begin immediate' : 'begin';
    await connection.executeQuery(CompiledQuery.raw(begin));
  }

  commitTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#inner.commitTransaction(connection);
  }

  rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#inner.rollbackTransaction(connection);
  }

  savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    return this.#inner.savepoint(connection, savepointName, compileQuery);
  }

  rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    return this.#inner.rollbackToSavepoint(connection, savepointName, compileQuery);
  }

  releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    return this.#inner.releaseSavepoint(connection, savepointName, compileQuery);
  }

  releaseConnection(): Promise<void> {
    return this.#inner.releaseConnection();
  }

  destroy(): Promise<void> {
    return this.#inner.destroy();
  }
}

class ImmediateSqliteDialect implements Dialect {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#database);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db);
  }
}

function applyPragmas(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  database.pragma('cache_size = -10240');
}

export function createSqliteDb(filename: string): Kysely<Schema> {
  const database = new Database(filename);
  applyPragmas(database);
  return new Kysely<Schema>({
    dialect: new ImmediateSqliteDialect(database),
    // Parse only projected JSON columns once; never re-parse nested string values.
    plugins: [new ParseJSONResultsPlugin({ shouldParse: shouldParseJsonResultColumn })],
  });
}

export class BetterSqliteAtomicRunner<DB> implements AtomicRunner<DB> {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  readGroup<T>(callback: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.#db.transaction().setAccessMode('read only').execute(callback);
  }

  async batchWrite({ executor, queries }: BatchWriteInput<DB>): Promise<readonly BatchStatementResult[]> {
    const run = async (trx: Kysely<DB>): Promise<BatchStatementResult[]> => {
      const results: BatchStatementResult[] = [];
      for (const query of queries) {
        const result = await trx.executeQuery(query);
        results.push({ changes: Number(result.numAffectedRows ?? 0n) });
      }
      return results;
    };
    // The single better-sqlite3 connection is already inside the caller's transaction;
    // opening another would deadlock on Kysely's connection mutex.
    if (executor.isTransaction) {
      return run(executor);
    }
    return executor.transaction().setAccessMode('read write').execute(run);
  }
}
