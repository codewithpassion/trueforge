import { env as bindings } from 'cloudflare:test';
import { SqliteAgentStore } from '../../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteIntegrationStore } from '../../../../src/db/sqlite/integration-store/SqliteIntegrationStore';
import { runIntegrationStoreContractSuite } from '../../integrationStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteIntegrationStore on D1 (IIntegrationStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runIntegrationStoreContractSuite({
    getAgentStore: () => new SqliteAgentStore(env.db),
    getIntegrationStore: () => new SqliteIntegrationStore(env.db, env.atomic),
  });
});
