import { sql } from 'kysely';

import { runSessionFileMetadataContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/sessionFileMetadataContractSuite';
import { PostgresSessionFileMetadataStore } from '../../../../src/db/postgres/session-file-store/PostgresSessionFileMetadataStore';
import { PostgresSessionStore } from '../../../../src/db/postgres/session-store/PostgresSessionStore';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresSessionFileMetadataStore (session_file contract)', () => {
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

  // One database per file; truncate between tests because CREATE DATABASE is slow.
  beforeEach(async () => {
    if (env !== undefined) {
      await sql`TRUNCATE TABLE session_file, session RESTART IDENTITY CASCADE`.execute(env.db);
    }
  });

  runSessionFileMetadataContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return { metadata: new PostgresSessionFileMetadataStore(env.db), sessionStore: new PostgresSessionStore(env.db) };
  });
});
