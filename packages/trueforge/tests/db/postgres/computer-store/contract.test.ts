import { sql } from 'kysely';

import { PostgresComputerStore } from '../../../../src/db/postgres/computer-store/PostgresComputerStore';
import { runComputerStoreContractSuite } from '../../computerStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresComputerStore (IComputerStore contract)', () => {
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
      await sql`TRUNCATE TABLE computer, computer_enrollment, computer_agent_access, computer_audit CASCADE`.execute(
        env.db,
      );
    }
  });

  runComputerStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresComputerStore(env.db);
  });
});
