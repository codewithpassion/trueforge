import { env as bindings } from 'cloudflare:test';
import { jsonbBind, nowIso } from '../../../../src/db/sqlite/sqlExpressions';
import { SqliteOAuthTokenStore } from '../../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { McpServerManifest } from '../../../../src/schemas/mcpServer';
import { runOAuthTokenStoreContractSuite, type OAuthTokenStoreHarness } from '../../oauthTokenStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteOAuthTokenStore on D1 (IOAuthTokenStore contract)', () => {
  let env: D1TestDatabase | undefined;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runOAuthTokenStoreContractSuite((): OAuthTokenStoreHarness => {
    if (env === undefined) {
      throw new Error('D1 test database not initialized');
    }
    const db = env.db;
    return {
      store: new SqliteOAuthTokenStore(db),
      async seedResource(id) {
        const manifest: McpServerManifest = {
          type: 'remote',
          name: id,
          url: 'https://mcp.example.com/sse',
          description: 'Test MCP server.',
        };
        await db
          .insertInto('mcp_server')
          .values({
            id,
            tenant_id: 'default',
            name: id,
            manifest: jsonbBind(manifest),
            oauth_server: null,
            oauth_client: null,
            created_at: nowIso(),
            updated_at: nowIso(),
          })
          .execute();
      },
      async expirePending(state) {
        await db
          .updateTable('oauth_pending_authorization')
          .set({ created_at: new Date(Date.now() - 3_600_000).toISOString() })
          .where('id', '=', state)
          .execute();
      },
    };
  });
});
