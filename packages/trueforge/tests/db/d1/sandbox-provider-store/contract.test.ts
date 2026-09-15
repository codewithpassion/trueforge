import { env as bindings } from 'cloudflare:test';
import { SqliteSandboxProviderStore } from '../../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { runSandboxProviderStoreContractSuite } from '../../sandboxProviderStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteSandboxProviderStore on D1 (ISandboxProviderStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runSandboxProviderStoreContractSuite(() => new SqliteSandboxProviderStore(env.db));
});
