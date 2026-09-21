import { env as bindings } from 'cloudflare:test';
import { SqliteComputerStore } from '../../../../src/db/sqlite/computer-store/SqliteComputerStore';
import { runComputerStoreContractSuite } from '../../computerStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteComputerStore on D1 (IComputerStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runComputerStoreContractSuite(() => new SqliteComputerStore(env.db, env.atomic));
});
