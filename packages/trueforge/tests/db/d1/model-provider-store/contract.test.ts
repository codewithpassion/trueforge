import { env as bindings } from 'cloudflare:test';
import { SqliteModelProviderStore } from '../../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { runModelProviderStoreContractSuite } from '../../modelProviderStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteModelProviderStore on D1 (IModelProviderStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runModelProviderStoreContractSuite(() => new SqliteModelProviderStore(env.db));
});
