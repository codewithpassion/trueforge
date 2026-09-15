import { BetterSqliteAtomicRunner } from '../../../src/db/sqlite/client';
import { runInListParametersSuite } from '../inListParametersSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from './testDatabase';

describe('SQLite store id-list filters (bound parameter count)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runInListParametersSuite(() => ({ db: env.db, atomic: new BetterSqliteAtomicRunner(env.db) }));
});
