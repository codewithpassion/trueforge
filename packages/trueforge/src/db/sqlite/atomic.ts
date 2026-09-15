import type { CompiledQuery, Kysely } from 'kysely';

export interface BatchStatementResult {
  /** Rows inserted, updated, or deleted by the statement. */
  changes: number;
}

export interface BatchWriteInput<DB> {
  /** Outer transaction handle when the caller holds one; otherwise the root db. */
  executor: Kysely<DB>;
  /** Write statements without RETURNING, run in order. */
  queries: readonly CompiledQuery[];
}

/**
 * The only atomicity primitive shared SQLite-dialect stores may use, so the same SQL
 * runs on better-sqlite3 and D1. D1 batches commit even when a statement matches zero
 * rows, so every statement after the first must re-check the first one's precondition
 * in SQL (conditional chain); the first statement's `changes` then decides the outcome.
 */
export interface AtomicRunner<DB> {
  /** Groups reads. Snapshot on better-sqlite3; sequential consistency only on D1. */
  readGroup<T>(callback: (db: Kysely<DB>) => Promise<T>): Promise<T>;
  /** All-or-nothing: any statement error rolls back the whole list. */
  batchWrite(input: BatchWriteInput<DB>): Promise<readonly BatchStatementResult[]>;
}
