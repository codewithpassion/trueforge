import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { chunkJsonRows, MAX_BOUND_JSON_BYTES } from '../../../../src/db/sqlite/session-store/sqlExpressions';
import { runSessionStoreAtomicWritesSuite } from '../../sessionStoreAtomicWritesSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSessionStore conditional-chain writes', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSessionStoreAtomicWritesSuite(() => ({ db: env.db, atomic: new BetterSqliteAtomicRunner(env.db) }));
});

describe('chunkJsonRows', () => {
  it('keeps order, measures UTF-8 bytes, and gives an oversized row its own chunk', () => {
    const small = Array.from({ length: 10 }, (_, i) => ({ i }));
    expect(chunkJsonRows(small)).toEqual([small]);

    const multibyte = ['é'.repeat(300_000), 'é'.repeat(300_000)];
    expect(chunkJsonRows(multibyte)).toEqual([[multibyte[0]], [multibyte[1]]]);

    const oversized = 'x'.repeat(MAX_BOUND_JSON_BYTES + 10);
    expect(chunkJsonRows(['a', oversized, 'b'])).toEqual([['a'], [oversized], ['b']]);

    const rows = Array.from({ length: 50 }, (_, i) => `${String(i)}${'y'.repeat(40_000)}`);
    const chunks = chunkJsonRows(rows);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(rows);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThanOrEqual(MAX_BOUND_JSON_BYTES);
    }
  });
});
