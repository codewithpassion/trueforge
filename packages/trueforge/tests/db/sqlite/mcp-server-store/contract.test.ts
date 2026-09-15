import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteOAuthTokenStore } from '../../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { runMcpServerStoreContractSuite } from '../../mcpServerStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteMcpServerStore (IMcpServerStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runMcpServerStoreContractSuite({
    getStore: () => new SqliteMcpServerStore(env.db, new BetterSqliteAtomicRunner(env.db)),
    getTokenStore: () => new SqliteOAuthTokenStore(env.db),
  });
});
