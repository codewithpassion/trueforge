import { env } from 'cloudflare:test';
import { sql, type Kysely } from 'kysely';

import { D1AtomicRunner } from '../../../src/db/d1/atomic';
import {
  createD1Db,
  D1_MAX_VALUE_BYTES,
  D1ValueTooLargeError,
  D1WriteOutcomeUnknownError,
  type D1Queryable,
  type D1Statement,
} from '../../../src/db/d1/client';
import { isUniqueViolation } from '../../../src/db/sqlite/errors';
import type { Database } from '../../../src/db/sqlite/types';

async function setup(): Promise<{ db: Kysely<Database>; runner: D1AtomicRunner }> {
  const db = createD1Db({ queryable: env.DB.withSession('first-primary') });
  await sql`DROP TABLE IF EXISTS child`.execute(db);
  await sql`DROP TABLE IF EXISTS parent`.execute(db);
  await sql`CREATE TABLE parent (id TEXT PRIMARY KEY, version INTEGER NOT NULL, doc BLOB) STRICT`.execute(db);
  await sql`CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL) STRICT`.execute(db);
  await sql`INSERT INTO parent (id, version, doc) VALUES ('p1', 1, jsonb('{"a":1}'))`.execute(db);
  return { db, runner: new D1AtomicRunner(env.DB) };
}

async function childCount(db: Kysely<Database>): Promise<number | undefined> {
  const result = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM child`.execute(db);
  return result.rows[0]?.n;
}

function guardedChain(db: Kysely<Database>, expectedVersion: number) {
  return [
    sql`UPDATE parent SET version = 2 WHERE id = 'p1' AND version = ${expectedVersion}`.compile(db),
    sql`INSERT INTO child (id, parent_id)
      SELECT 'c1', 'p1' WHERE EXISTS (SELECT 1 FROM parent WHERE id = 'p1' AND version = 2)`.compile(db),
  ];
}

async function bound(db: Kysely<Database>, value: unknown): Promise<{ value: unknown; type: string } | undefined> {
  const result = await sql<{
    value: unknown;
    type: string;
  }>`SELECT ${value} AS value, typeof(${value}) AS type`.execute(db);
  return result.rows[0];
}

/** A D1 stand-in whose statements report `metas[i]` exactly as given (a single statement uses `metas[0]`). */
function stubQueryable(metas: readonly { changes?: unknown; last_row_id?: unknown }[]): D1Queryable {
  const statement: D1Statement = {
    all: <R>() => Promise.resolve({ results: new Array<R>(), meta: metas[0] ?? {} }),
  };
  return {
    prepare: () => ({ bind: () => statement }),
    batch: statements => Promise.resolve(statements.map((_, index) => ({ results: [], meta: metas[index] ?? {} }))),
  };
}

describe('D1 value size guard and statement counter', () => {
  function recordingQueryable(): { queryable: D1Queryable; sent: string[] } {
    const sent: string[] = [];
    const statement: D1Statement = { all: <R>() => Promise.resolve({ results: new Array<R>(), meta: { changes: 1 } }) };
    return {
      sent,
      queryable: {
        prepare: sqlText => {
          sent.push(sqlText);
          return { bind: () => statement };
        },
        batch: statements => Promise.resolve(statements.map(() => ({ results: [], meta: { changes: 1 } }))),
      },
    };
  }

  it('rejects a statement whose bound string is over the limit before sending it', async () => {
    const { queryable, sent } = recordingQueryable();
    const db = createD1Db({ queryable });
    // Multi-byte text: the UTF-8 size, not the string length, is what D1 limits.
    const oversized = 'é'.repeat(D1_MAX_VALUE_BYTES / 2 + 1);

    await expect(sql`INSERT INTO parent (id) VALUES (${oversized})`.execute(db)).rejects.toBeInstanceOf(
      D1ValueTooLargeError,
    );
    expect(sent).toEqual([]);
  });

  it('accepts a value at exactly the limit', async () => {
    const { queryable } = recordingQueryable();
    const db = createD1Db({ queryable });

    await expect(
      sql`INSERT INTO parent (id) VALUES (${'a'.repeat(D1_MAX_VALUE_BYTES)})`.execute(db),
    ).resolves.toBeDefined();
  });

  it('rejects an oversized member of a batch before sending any statement', async () => {
    const { queryable } = recordingQueryable();
    let batched = 0;
    const db = createD1Db({
      queryable: {
        ...queryable,
        batch: statements => {
          batched += statements.length;
          return queryable.batch(statements);
        },
      },
    });
    const runner = new D1AtomicRunner(env.DB);
    const queries = [
      sql`UPDATE parent SET version = 2`.compile(db),
      sql`INSERT INTO child (id) VALUES (${new Uint8Array(D1_MAX_VALUE_BYTES + 1)})`.compile(db),
    ];

    await expect(runner.batchWrite({ executor: db, queries })).rejects.toBeInstanceOf(D1ValueTooLargeError);
    expect(batched).toBe(0);
  });

  it('counts single statements and every member of a batch', async () => {
    const { queryable } = recordingQueryable();
    let statements = 0;
    const db = createD1Db({
      queryable,
      onStatements: count => {
        statements += count;
      },
    });
    const runner = new D1AtomicRunner(env.DB);

    await sql`SELECT 1`.execute(db);
    await runner.batchWrite({ executor: db, queries: guardedChain(db, 1) });

    expect(statements).toBe(3);
  });
});

describe('D1AtomicRunner.batchWrite', () => {
  it('reports zero changes for a failed guard and leaves chained inserts unwritten', async () => {
    const { db, runner } = await setup();

    await expect(runner.batchWrite({ executor: db, queries: guardedChain(db, 0) })).resolves.toEqual([
      { changes: 0 },
      { changes: 0 },
    ]);
    expect(await childCount(db)).toBe(0);

    await expect(runner.batchWrite({ executor: db, queries: guardedChain(db, 1) })).resolves.toEqual([
      { changes: 1 },
      { changes: 1 },
    ]);
    expect(await childCount(db)).toBe(1);
  });

  it('counts rows for INSERT ... SELECT and DELETE', async () => {
    const { db, runner } = await setup();
    const rows = JSON.stringify(['a', 'b', 'c']);

    await expect(
      runner.batchWrite({
        executor: db,
        queries: [
          sql`INSERT INTO child (id, parent_id) SELECT value, 'p1' FROM json_each(${rows})`.compile(db),
          sql`DELETE FROM child WHERE parent_id = 'p1'`.compile(db),
        ],
      }),
    ).resolves.toEqual([{ changes: 3 }, { changes: 3 }]);
  });

  it('rolls back earlier statements when a later one errors, with an error isUniqueViolation recognizes', async () => {
    const { db, runner } = await setup();

    const failure = await runner
      .batchWrite({
        executor: db,
        queries: [
          sql`INSERT INTO child (id, parent_id) VALUES ('dup', 'p1')`.compile(db),
          sql`INSERT INTO child (id, parent_id) VALUES ('dup', 'p1')`.compile(db),
        ],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/UNIQUE constraint failed: child\.id/);
    expect(isUniqueViolation(failure)).toBe(true);
    expect(await childCount(db)).toBe(0);
  });

  it('refuses interactive transactions', async () => {
    const { db } = await setup();
    await expect(db.transaction().execute(() => Promise.resolve())).rejects.toThrow(/no interactive transactions/);
  });

  it('throws D1WriteOutcomeUnknownError when statement 0 has no numeric meta.changes instead of reporting zero', async () => {
    const runner = new D1AtomicRunner(env.DB);
    const executor = createD1Db({ queryable: stubQueryable([{}, { changes: 1 }]) });
    const queries = [sql`UPDATE parent SET version = 2`.compile(executor), sql`DELETE FROM child`.compile(executor)];

    const failure = runner.batchWrite({ executor, queries });
    await expect(failure).rejects.toBeInstanceOf(D1WriteOutcomeUnknownError);
    await expect(failure).rejects.toThrow(/the write committed/);
  });

  it('accepts a committed batch whose later statement has no numeric meta.changes', async () => {
    const runner = new D1AtomicRunner(env.DB);
    const executor = createD1Db({ queryable: stubQueryable([{ changes: 1 }, {}]) });
    const queries = [sql`UPDATE parent SET version = 2`.compile(executor), sql`DELETE FROM child`.compile(executor)];

    await expect(runner.batchWrite({ executor, queries })).resolves.toEqual([{ changes: 1 }, { changes: 0 }]);
  });
});

describe('D1 dialect result metadata', () => {
  it('throws D1WriteOutcomeUnknownError for a write without numeric meta.changes', async () => {
    const db = createD1Db({ queryable: stubQueryable([{}]) });
    await expect(sql`UPDATE parent SET version = 3`.execute(db)).rejects.toBeInstanceOf(D1WriteOutcomeUnknownError);
    await expect(
      db.updateTable('turn').set({ updated_at: 'now' }).where('turn_id', '=', 't1').executeTakeFirst(),
    ).rejects.toBeInstanceOf(D1WriteOutcomeUnknownError);
  });

  it('leaves numAffectedRows and insertId unset for reads when D1 omits changes and last_row_id', async () => {
    const db = createD1Db({ queryable: stubQueryable([{}]) });
    const result = await sql`SELECT version FROM parent`.execute(db);
    expect(result.numAffectedRows).toBeUndefined();
    expect(result.insertId).toBeUndefined();
    const returning = await db.deleteFrom('turn').where('turn_id', '=', 't1').returning('turn_id').execute();
    expect(returning).toEqual([]);
  });

  it('converts numeric changes and last_row_id', async () => {
    const db = createD1Db({ queryable: stubQueryable([{ changes: 2, last_row_id: 5 }]) });
    const result = await sql`UPDATE parent SET version = 3`.execute(db);
    expect(result.numAffectedRows).toBe(2n);
    expect(result.insertId).toBe(5n);
  });
});

describe('D1 dialect bind parameters and results', () => {
  it('binds strings, numbers, null, and Uint8Array', async () => {
    const { db } = await setup();
    expect(await bound(db, 'text')).toEqual({ value: 'text', type: 'text' });
    expect(await bound(db, 7)).toEqual({ value: 7, type: expect.stringMatching(/^(integer|real)$/) });
    expect(await bound(db, 1.5)).toEqual({ value: 1.5, type: 'real' });
    expect(await bound(db, null)).toEqual({ value: null, type: 'null' });
    // BLOB results come back as arrays of byte values, not Buffers.
    expect(await bound(db, new Uint8Array([1, 2, 3]))).toEqual({ value: [1, 2, 3], type: 'blob' });
  });

  it('binds booleans as numbers (better-sqlite3 rejects them)', async () => {
    const { db } = await setup();
    expect((await bound(db, true))?.value).toBe(1);
    expect((await bound(db, false))?.value).toBe(0);
  });

  it('rejects Date, bigint, and undefined, so stores bind ISO strings and numbers', async () => {
    const { db } = await setup();
    await expect(bound(db, new Date('2026-01-01T00:00:00.000Z'))).rejects.toThrow(/D1_TYPE_ERROR/);
    await expect(bound(db, 10n)).rejects.toThrow(/D1_TYPE_ERROR/);
    await expect(bound(db, undefined)).rejects.toThrow(/D1_TYPE_ERROR/);
  });

  it('returns a raw JSONB column as bytes and a json() projection as parsed JSON', async () => {
    const { db } = await setup();
    const raw = await sql<{ doc: unknown }>`SELECT doc FROM parent WHERE id = 'p1'`.execute(db);
    expect(Array.isArray(raw.rows[0]?.doc)).toBe(true);
    const projected = await sql<{
      manifest: unknown;
    }>`SELECT json(doc) AS manifest FROM parent WHERE id = 'p1'`.execute(db);
    expect(projected.rows[0]?.manifest).toEqual({ a: 1 });
  });

  it('rejects more than 100 bound parameters in one statement', async () => {
    const { db } = await setup();
    const values = Array.from({ length: 101 }, (_, i) => i);
    await expect(sql`SELECT ${sql.join(values)}`.execute(db)).rejects.toThrow(/too many SQL variables/);
  });
});
