import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { runScheduleConcurrentUpdateSuite } from '../../scheduleConcurrentUpdateSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteScheduleStore updated_at guard', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    await env?.teardown();
  });

  runScheduleConcurrentUpdateSuite({
    getHarness: () => ({
      db: env.db,
      atomic: new BetterSqliteAtomicRunner(env.db),
      withTransaction: callback => env.db.transaction().execute(callback),
    }),
    freezeNow: ms => {
      jest.spyOn(Date, 'now').mockReturnValue(ms);
    },
  });
});
