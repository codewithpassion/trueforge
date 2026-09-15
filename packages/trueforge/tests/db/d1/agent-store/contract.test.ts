import { env as bindings } from 'cloudflare:test';
import { SqliteAgentStore } from '../../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { runAgentStoreContractSuite } from '../../agentStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteAgentStore on D1 (IAgentStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runAgentStoreContractSuite(() => new SqliteAgentStore(env.db));
});
