import {
  Kysely,
  ParseJSONResultsPlugin,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { BatchStatementResult } from '../sqlite/atomic';
import { shouldParseJsonResultColumn } from '../sqlite/jsonColumns';
import type { Database } from '../sqlite/types';

/** Result metadata is read defensively: a missing field must not be mistaken for zero rows. */
interface D1StatementResult<R> {
  results: R[];
  meta: { changes?: unknown; last_row_id?: unknown };
}

export interface D1Statement {
  all<R>(): Promise<D1StatementResult<R>>;
}

/** What the dialect needs from a D1 binding or a Sessions API session; both satisfy it. */
export interface D1Queryable {
  prepare(sql: string): { bind(...values: unknown[]): D1Statement };
  batch(statements: D1Statement[]): Promise<D1StatementResult<unknown>[]>;
}

const NO_TRANSACTIONS = 'D1 has no interactive transactions; write through AtomicRunner.batchWrite';

export class D1Connection implements DatabaseConnection {
  readonly #target: D1Queryable;

  constructor(target: D1Queryable) {
    this.#target = target;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const { results, meta } = await this.#target
      .prepare(query.sql)
      .bind(...query.parameters)
      .all<R>();
    return {
      rows: results,
      ...(typeof meta.changes === 'number' ? { numAffectedRows: BigInt(meta.changes) } : {}),
      ...(typeof meta.last_row_id === 'number' ? { insertId: BigInt(meta.last_row_id) } : {}),
    };
  }

  /**
   * One D1 batch: a single implicit transaction that rolls back only when a statement errors.
   * Throws when a statement reports no change count, since callers read zero as a failed guard.
   */
  async batch(queries: readonly CompiledQuery[]): Promise<BatchStatementResult[]> {
    if (queries.length === 0) {
      return [];
    }
    const results = await this.#target.batch(
      queries.map(query => this.#target.prepare(query.sql).bind(...query.parameters)),
    );
    return results.map(({ meta }, index) => {
      if (typeof meta.changes !== 'number') {
        throw new Error(`D1 batch statement ${String(index)} returned no numeric meta.changes; the batch committed`);
      }
      return { changes: meta.changes };
    });
  }

  streamQuery(): AsyncIterableIterator<QueryResult<never>> {
    throw new Error('D1 does not support streaming queries');
  }
}

class D1Driver implements Driver {
  readonly #target: D1Queryable;

  constructor(target: D1Queryable) {
    this.#target = target;
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(new D1Connection(this.#target));
  }

  beginTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }

  commitTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }

  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

class D1Dialect implements Dialect {
  readonly #target: D1Queryable;

  constructor(target: D1Queryable) {
    this.#target = target;
  }

  createDriver(): Driver {
    return new D1Driver(this.#target);
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

/** Every statement this instance runs goes to `queryable`, so reads and batches share its consistency. */
export function createD1Db({ queryable }: { queryable: D1Queryable }): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new D1Dialect(queryable),
    plugins: [new ParseJSONResultsPlugin({ shouldParse: shouldParseJsonResultColumn })],
  });
}
