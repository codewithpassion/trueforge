import { sql } from 'kysely';

import { PostgresAgentStore } from '../../../../src/db/postgres/agent-store/PostgresAgentStore';
import { PostgresIntegrationStore } from '../../../../src/db/postgres/integration-store/PostgresIntegrationStore';
import { runIntegrationStoreContractSuite } from '../../integrationStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresIntegrationStore (IIntegrationStore contract)', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  beforeEach(async () => {
    if (env !== undefined) {
      await sql`TRUNCATE TABLE agent, integration CASCADE`.execute(env.db);
    }
  });

  runIntegrationStoreContractSuite({
    getAgentStore: () => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return new PostgresAgentStore(env.db);
    },
    getIntegrationStore: () => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return new PostgresIntegrationStore(env.db);
    },
  });
});
