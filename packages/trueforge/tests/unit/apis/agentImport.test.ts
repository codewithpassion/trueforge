import { createAgentImportRouter } from '../../../src/apis/agentImport';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';

const importItem = {
  tenant_id: 'default',
  manifest: { model: { name: 'anthropic/claude-sonnet-4-6' } },
  created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'User One' },
  truefoundry_managed_agent_id: 'tfy-agent-1',
};

type ImportResponse = { data: { results: { name: string; status: string; agent_id?: string }[] } };

describe('agent import router', () => {
  let router: ReturnType<typeof createAgentImportRouter>;
  let agentStore: SqliteAgentStore;

  beforeAll(async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    agentStore = new SqliteAgentStore(db);
    router = createAgentImportRouter({
      sessionImport: undefined,
      resolveImportAgentStore: () => agentStore,
    });
  });

  async function importAgent(item: Record<string, unknown>) {
    const response = await router.request('/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: [item] }),
    });
    expect(response.status).toBe(200);
    const result = ((await response.json()) as ImportResponse).data.results[0];
    expect(result?.status).toBe('created');
    const agentId = result?.agent_id;
    if (agentId === undefined) throw new Error('Import did not return an agent id');
    return agentStore.getAgent({ tenant_id: 'default', id: agentId });
  }

  it('stores an empty description when the import row has none', async () => {
    const stored = await importAgent({ ...importItem, name: 'imported-no-desc' });
    expect(stored?.description).toBe('');
  });

  it('stores the provided description', async () => {
    const stored = await importAgent({ ...importItem, name: 'imported-desc', description: 'Imported helper.' });
    expect(stored?.description).toBe('Imported helper.');
  });
});
