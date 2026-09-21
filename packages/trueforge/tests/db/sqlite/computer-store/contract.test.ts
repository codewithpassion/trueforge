import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { SqliteComputerStore } from '../../../../src/db/sqlite/computer-store/SqliteComputerStore';
import { runComputerStoreContractSuite } from '../../computerStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteComputerStore (IComputerStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runComputerStoreContractSuite(() => new SqliteComputerStore(env.db, new BetterSqliteAtomicRunner(env.db)));
});
