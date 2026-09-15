import type { Kysely } from 'kysely';

import type { AtomicRunner, BatchStatementResult, BatchWriteInput } from '../../../src/db/sqlite/atomic';

/**
 * Runs a one-shot write just before the next batch, on the batch's own executor, to stand in
 * for a concurrent writer landing between a store's reads and its batch.
 */
export class InterleavingAtomicRunner<DB> implements AtomicRunner<DB> {
  readonly #inner: AtomicRunner<DB>;
  #pending: ((executor: Kysely<DB>) => Promise<void>) | undefined;

  constructor(inner: AtomicRunner<DB>) {
    this.#inner = inner;
  }

  beforeNextBatch(interleave: (executor: Kysely<DB>) => Promise<void>): void {
    this.#pending = interleave;
  }

  readGroup<T>(callback: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.#inner.readGroup(callback);
  }

  async batchWrite(input: BatchWriteInput<DB>): Promise<readonly BatchStatementResult[]> {
    const interleave = this.#pending;
    this.#pending = undefined;
    if (interleave !== undefined) {
      await interleave(input.executor);
    }
    return this.#inner.batchWrite(input);
  }
}
