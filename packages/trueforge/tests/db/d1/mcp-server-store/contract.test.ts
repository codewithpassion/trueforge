import { env as bindings } from 'cloudflare:test';
import { SqliteMcpServerStore } from '../../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteOAuthTokenStore } from '../../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { runMcpServerStoreContractSuite } from '../../mcpServerStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteMcpServerStore on D1 (IMcpServerStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runMcpServerStoreContractSuite({
    getStore: () => new SqliteMcpServerStore(env.db, env.atomic),
    getTokenStore: () => new SqliteOAuthTokenStore(env.db),
  });
});
