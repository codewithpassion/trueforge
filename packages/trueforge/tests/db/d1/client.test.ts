import { env } from 'cloudflare:test';
import { sql, type Kysely } from 'kysely';

import { D1AtomicRunner } from '../../../src/db/d1/atomic';
import { createD1Db, type D1Queryable, type D1Statement } from '../../../src/db/d1/client';
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

/** A D1 stand-in whose statements report `meta` exactly as given. */
function stubQueryable(meta: { changes?: unknown; last_row_id?: unknown }): D1Queryable {
  const statement: D1Statement = {
    all: <R>() => Promise.resolve({ results: new Array<R>(), meta }),
  };
  return {
    prepare: () => ({ bind: () => statement }),
    batch: statements => Promise.resolve(statements.map(() => ({ results: [], meta }))),
  };
}

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

  it('throws when a batch statement result has no numeric meta.changes instead of reporting zero', async () => {
    const runner = new D1AtomicRunner(env.DB);
    const executor = createD1Db({ queryable: stubQueryable({}) });

    await expect(runner.batchWrite({ executor, queries: [sql`SELECT 1`.compile(executor)] })).rejects.toThrow(
      /no numeric meta\.changes/,
    );
  });
});

describe('D1 dialect result metadata', () => {
  it('leaves numAffectedRows and insertId unset when D1 omits changes and last_row_id', async () => {
    const db = createD1Db({ queryable: stubQueryable({}) });
    const result = await sql`UPDATE parent SET version = 3`.execute(db);
    expect(result.numAffectedRows).toBeUndefined();
    expect(result.insertId).toBeUndefined();
  });

  it('converts numeric changes and last_row_id', async () => {
    const db = createD1Db({ queryable: stubQueryable({ changes: 2, last_row_id: 5 }) });
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
