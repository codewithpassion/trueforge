import { SqliteAgentStore } from '../../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { SqliteIntegrationStore } from '../../../../src/db/sqlite/integration-store/SqliteIntegrationStore';
import { runIntegrationStoreContractSuite } from '../../integrationStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteIntegrationStore (IIntegrationStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runIntegrationStoreContractSuite({
    getAgentStore: () => new SqliteAgentStore(env.db),
    getIntegrationStore: () => new SqliteIntegrationStore(env.db, new BetterSqliteAtomicRunner(env.db)),
  });
});
