import type { Kysely } from 'kysely';
import { McpServerWithAuthStore } from '../McpServerWithAuthStore';
import { SqliteAgentStore } from './agent-store/SqliteAgentStore';
import type { AtomicRunner } from './atomic';
import { SqliteComputerStore } from './computer-store/SqliteComputerStore';
import { SqliteIntegrationStore } from './integration-store/SqliteIntegrationStore';
import { SqliteMcpServerStore } from './mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from './model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from './sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteScheduleStore } from './schedule-store/SqliteScheduleStore';
import { SqliteSessionFileMetadataStore } from './session-file-store/SqliteSessionFileMetadataStore';
import { SqliteSessionMetricsStore } from './session-metrics/SqliteSessionMetricsStore';
import { SqliteSessionStore } from './session-store/SqliteSessionStore';
import { SqliteSkillStore } from './skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from './token-store/SqliteOAuthTokenStore';
import type { Database } from './types';

/** Every SQLite-dialect store over one database, shared by the better-sqlite3 and D1 entry points. */
export function createSqliteStores({
  db,
  atomic,
  mcpClientName,
}: {
  db: Kysely<Database>;
  atomic: AtomicRunner<Database>;
  mcpClientName: string;
}) {
  const tokenStore = new SqliteOAuthTokenStore(db);
  return {
    sessionStore: new SqliteSessionStore(db, atomic),
    sessionFileMetadataStore: new SqliteSessionFileMetadataStore(db),
    sessionMetricsStore: new SqliteSessionMetricsStore(db),
    tokenStore,
    mcpServerStore: new McpServerWithAuthStore<Kysely<Database>>({
      store: new SqliteMcpServerStore(db, atomic),
      tokenStore,
      clientName: mcpClientName,
    }),
    scheduleStore: new SqliteScheduleStore(db, atomic),
    integrationStore: new SqliteIntegrationStore(db, atomic),
    computerStore: new SqliteComputerStore(db, atomic),
    agentStore: new SqliteAgentStore(db),
    modelProviderStore: new SqliteModelProviderStore(db),
    sandboxProviderStore: new SqliteSandboxProviderStore(db),
    skillStore: new SqliteSkillStore(db),
  };
}
