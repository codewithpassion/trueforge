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

/**
 * A write committed but D1 reported no change count. Callers read zero changes as a failed guard,
 * so the dialect throws instead of guessing.
 */
export class D1WriteOutcomeUnknownError extends Error {
  constructor(statement: string, options?: { cause?: unknown }) {
    super(
      `D1 ${statement} returned no numeric meta.changes; the write committed but its row count is unknown`,
      options,
    );
    this.name = 'D1WriteOutcomeUnknownError';
  }
}

/** D1 rejects any single string, BLOB, or row larger than this. */
export const D1_MAX_VALUE_BYTES = 2_000_000;

/**
 * A statement is over D1's size limit: one bound value, or all bound values together (a row). Thrown
 * before the statement is sent, so callers get a named error instead of D1's raw rejection (local D1
 * does not enforce the limit at all).
 */
export class D1ValueTooLargeError extends Error {
  readonly byteLength: number;
  readonly scope: 'value' | 'statement';

  constructor({ byteLength, scope }: { byteLength: number; scope: 'value' | 'statement' }) {
    super(
      scope === 'value'
        ? `A ${String(byteLength)}-byte value exceeds the ${String(D1_MAX_VALUE_BYTES)}-byte limit D1 applies to one stored value`
        : `Bound values totalling ${String(byteLength)} bytes exceed the ${String(D1_MAX_VALUE_BYTES)}-byte limit D1 applies to one row`,
    );
    this.name = 'D1ValueTooLargeError';
    this.byteLength = byteLength;
    this.scope = scope;
  }
}

/** Receives how many statements were sent to D1, for per-invocation query budgeting. */
export type D1StatementCounter = (statements: number) => void;

const utf8 = new TextEncoder();

/** Numbers, booleans, and null are fixed-size; 8 bytes covers the widest. */
const SCALAR_BYTES = 8;

function boundByteLength(value: unknown, { exact }: { exact: boolean }): number {
  if (typeof value === 'string') {
    // UTF-8 needs at most 3 bytes per UTF-16 unit, so the upper bound skips the encode.
    return exact ? utf8.encode(value).byteLength : value.length * 3;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  return SCALAR_BYTES;
}

/**
 * Rejects a statement D1 would refuse for size. The sum of all bound values is an upper bound for the
 * row an INSERT writes, so it errs toward rejecting a statement whose values span several rows.
 */
export function assertStatementFitsD1(parameters: readonly unknown[]): void {
  let upperBound = 0;
  for (const value of parameters) {
    upperBound += boundByteLength(value, { exact: false });
  }
  if (upperBound <= D1_MAX_VALUE_BYTES) {
    return;
  }
  let total = 0;
  for (const value of parameters) {
    const byteLength = boundByteLength(value, { exact: true });
    if (byteLength > D1_MAX_VALUE_BYTES) {
      throw new D1ValueTooLargeError({ byteLength, scope: 'value' });
    }
    total += byteLength;
  }
  if (total > D1_MAX_VALUE_BYTES) {
    throw new D1ValueTooLargeError({ byteLength: total, scope: 'statement' });
  }
}

/** Statements that return rows (SELECT or RETURNING) do not need a change count. */
function returnsRows(query: CompiledQuery): boolean {
  const node = query.query;
  switch (node.kind) {
    case 'SelectQueryNode':
      return true;
    case 'InsertQueryNode':
    case 'UpdateQueryNode':
    case 'DeleteQueryNode':
      return node.returning !== undefined;
    default:
      return /^\s*(select|with|pragma|explain|values)\b/i.test(query.sql) || /\breturning\b/i.test(query.sql);
  }
}

export class D1Connection implements DatabaseConnection {
  readonly #target: D1Queryable;
  readonly #onStatements: D1StatementCounter | undefined;

  constructor(target: D1Queryable, onStatements: D1StatementCounter | undefined) {
    this.#target = target;
    this.#onStatements = onStatements;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    assertStatementFitsD1(query.parameters);
    this.#onStatements?.(1);
    const { results, meta } = await this.#target
      .prepare(query.sql)
      .bind(...query.parameters)
      .all<R>();
    if (typeof meta.changes !== 'number' && !returnsRows(query)) {
      throw new D1WriteOutcomeUnknownError('statement');
    }
    return {
      rows: results,
      ...(typeof meta.changes === 'number' ? { numAffectedRows: BigInt(meta.changes) } : {}),
      ...(typeof meta.last_row_id === 'number' ? { insertId: BigInt(meta.last_row_id) } : {}),
    };
  }

  /**
   * One D1 batch: a single implicit transaction that rolls back only when a statement errors.
   * Only statement 0's change count decides a conditional chain, so only it must be present;
   * stores never read later counts.
   */
  async batch(queries: readonly CompiledQuery[]): Promise<BatchStatementResult[]> {
    if (queries.length === 0) {
      return [];
    }
    for (const query of queries) {
      assertStatementFitsD1(query.parameters);
    }
    // D1 counts every statement in a batch against the invocation's query limit.
    this.#onStatements?.(queries.length);
    const results = await this.#target.batch(
      queries.map(query => this.#target.prepare(query.sql).bind(...query.parameters)),
    );
    return results.map(({ meta }, index) => {
      if (typeof meta.changes === 'number') {
        return { changes: meta.changes };
      }
      if (index === 0) {
        throw new D1WriteOutcomeUnknownError('batch statement 0');
      }
      return { changes: 0 };
    });
  }

  streamQuery(): AsyncIterableIterator<QueryResult<never>> {
    throw new Error('D1 does not support streaming queries');
  }
}

class D1Driver implements Driver {
  readonly #target: D1Queryable;
  readonly #onStatements: D1StatementCounter | undefined;

  constructor(target: D1Queryable, onStatements: D1StatementCounter | undefined) {
    this.#target = target;
    this.#onStatements = onStatements;
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(new D1Connection(this.#target, this.#onStatements));
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
  readonly #onStatements: D1StatementCounter | undefined;

  constructor(target: D1Queryable, onStatements: D1StatementCounter | undefined) {
    this.#target = target;
    this.#onStatements = onStatements;
  }

  createDriver(): Driver {
    return new D1Driver(this.#target, this.#onStatements);
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
export function createD1Db({
  queryable,
  onStatements,
}: {
  queryable: D1Queryable;
  onStatements?: D1StatementCounter | undefined;
}): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new D1Dialect(queryable, onStatements),
    plugins: [new ParseJSONResultsPlugin({ shouldParse: shouldParseJsonResultColumn })],
  });
}
