import { runSessionFileMetadataContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/sessionFileMetadataContractSuite';
import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { SqliteSessionFileMetadataStore } from '../../../../src/db/sqlite/session-file-store/SqliteSessionFileMetadataStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSessionFileMetadataStore (session_file contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSessionFileMetadataContractSuite(() => ({
    metadata: new SqliteSessionFileMetadataStore(env.db),
    sessionStore: new SqliteSessionStore(env.db, new BetterSqliteAtomicRunner(env.db)),
  }));
});
