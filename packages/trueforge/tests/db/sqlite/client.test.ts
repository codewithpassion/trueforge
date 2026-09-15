import { sql, type Kysely } from 'kysely';

import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import type { Database } from '../../../src/db/sqlite/types';

async function setup(): Promise<{ db: Kysely<Database>; runner: BetterSqliteAtomicRunner<Database> }> {
  const db = createSqliteDb(':memory:');
  await sql`CREATE TABLE parent (id TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT`.execute(db);
  await sql`CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL) STRICT`.execute(db);
  await sql`INSERT INTO parent (id, version) VALUES ('p1', 1)`.execute(db);
  return { db, runner: new BetterSqliteAtomicRunner(db) };
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

describe('BetterSqliteAtomicRunner.batchWrite', () => {
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
    await db.destroy();
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
    await db.destroy();
  });

  it('rolls back earlier statements when a later one errors', async () => {
    const { db, runner } = await setup();

    await expect(
      runner.batchWrite({
        executor: db,
        queries: [
          sql`INSERT INTO child (id, parent_id) VALUES ('dup', 'p1')`.compile(db),
          sql`INSERT INTO child (id, parent_id) VALUES ('dup', 'p1')`.compile(db),
        ],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await childCount(db)).toBe(0);
    await db.destroy();
  });

  it('runs inside an outer transaction instead of opening a nested one', async () => {
    const { db, runner } = await setup();

    await expect(
      db.transaction().execute(async trx => {
        const results = await runner.batchWrite({
          executor: trx,
          queries: [sql`INSERT INTO child (id, parent_id) VALUES ('c1', 'p1')`.compile(trx)],
        });
        expect(results).toEqual([{ changes: 1 }]);
        expect(await childCount(trx)).toBe(1);
        throw new Error('abort outer transaction');
      }),
    ).rejects.toThrow('abort outer transaction');
    // The batch shared the outer transaction, so the outer rollback removed its insert.
    expect(await childCount(db)).toBe(0);
    await db.destroy();
  });
});
