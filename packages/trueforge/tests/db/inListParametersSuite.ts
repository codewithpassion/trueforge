/**
 * Store reads filtered by caller-sized id lists must bind a constant number of parameters:
 * D1 rejects a statement with more than 100. Runs under Jest (better-sqlite3) and
 * vitest-pool-workers (D1); on D1 an over-limit statement would also fail outright.
 */
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import type { CompiledQuery, Kysely, KyselyPlugin } from 'kysely';

import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import type { RequestContext } from '../../src/auth/identity';
import { SqliteAgentStore } from '../../src/db/sqlite/agent-store/SqliteAgentStore';
import type { AtomicRunner } from '../../src/db/sqlite/atomic';
import { SqliteMcpServerStore } from '../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteScheduleStore } from '../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { Database } from '../../src/db/sqlite/types';

const MAX_BOUND_PARAMETERS = 100;
const TENANT = 'default';
const OWNER = 'owner';
const IDS = Array.from({ length: 500 }, (_, i) => `id-${String(i)}`);

const CONTEXT: RequestContext = {
  tenant_id: TENANT,
  subject: { id: OWNER, type: 'user', display_name: OWNER },
  roles: [],
  user_credential: null,
};

export function runInListParametersSuite(getHarness: () => { db: Kysely<Database>; atomic: AtomicRunner<Database> }) {
  let queries: CompiledQuery[];
  let db: Kysely<Database>;
  let atomic: AtomicRunner<Database>;

  beforeEach(() => {
    const harness = getHarness();
    queries = [];
    const recorder: KyselyPlugin = {
      transformQuery: ({ node, queryId }) => {
        queries.push(harness.db.getExecutor().compileQuery(node, queryId));
        return node;
      },
      transformResult: ({ result }) => Promise.resolve(result),
    };
    db = harness.db.withPlugin(recorder);
    atomic = harness.atomic;
  });

  function expectBoundedParameters(): void {
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.parameters.length).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    }
  }

  it('session getOwnedIds and listSessions agent filter', async () => {
    const store = new SqliteSessionStore(db, atomic);
    await expect(store.getOwnedIds({ tenant_id: TENANT, ids: IDS, subject_id: OWNER })).resolves.toEqual([]);
    const listed = await store.listSessions({
      tenant_id: TENANT,
      limit: 10,
      page_token: undefined,
      order: undefined,
      start_timestamp: undefined,
      end_timestamp: undefined,
      agent_id: undefined,
      created_by_or_agent_ids: { created_by_subject_id: OWNER, agent_ids: IDS },
      metadata: undefined,
      source_type: undefined,
      source_id: undefined,
    });
    expect(listed.data).toEqual([]);
    expectBoundedParameters();
  });

  it('agent getOwnedIds, getExternalIdsByIds, and listAgents external_ids', async () => {
    const store = new SqliteAgentStore(db);
    await expect(store.getOwnedIds({ tenant_id: TENANT, ids: IDS, subject_id: OWNER })).resolves.toEqual([]);
    await expect(store.getExternalIdsByIds({ tenant_id: TENANT, ids: IDS })).resolves.toEqual([]);
    const listed = await store.listAgents({
      tenant_id: TENANT,
      external_ids: IDS,
      agent_name: undefined,
      limit: 10,
      page_token: undefined,
    });
    expect(listed.data).toEqual([]);
    expectBoundedParameters();
  });

  it('schedule getOwnedIds and listSchedules agent_names plus agent filter', async () => {
    const store = new SqliteScheduleStore(db, atomic);
    await expect(store.getOwnedIds({ tenant_id: TENANT, ids: IDS, subject_id: OWNER })).resolves.toEqual([]);
    const listed = await store.listSchedules({
      tenant_id: TENANT,
      limit: 10,
      page_token: undefined,
      agent_names: IDS,
      created_by_or_agent_ids: { created_by_subject_id: OWNER, agent_ids: IDS },
    });
    expect(listed.data).toEqual([]);
    expectBoundedParameters();
  });

  it('mcp listServers, token getTokens, and skill listSkills name filters', async () => {
    await expect(new SqliteMcpServerStore(db, atomic).listServers({ tenant_id: TENANT, names: IDS })).resolves.toEqual(
      [],
    );
    await expect(new SqliteOAuthTokenStore(db).getTokens({ ids: IDS, userRef: OWNER })).resolves.toEqual(new Map());
    await expect(new SqliteSkillStore(db).listSkills({ tenant_id: TENANT, names: IDS })).resolves.toEqual([]);
    expectBoundedParameters();
  });

  it('default authorizer permissions for 100 resource ids of every type', async () => {
    const agentStore = new SqliteAgentStore(db);
    const owned = await agentStore.createAgent({
      tenant_id: TENANT,
      created_by_subject: { subject_id: OWNER, subject_type: 'user', subject_display_name: OWNER },
      name: 'owned',
      description: 'Owned agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'anthropic/claude-sonnet-4-6' }, instructions: 'Be helpful.' }),
      external_id: null,
    });
    const resourceIds = [owned.id, ...IDS.slice(0, 99)];
    const authorizer = new TrueForgeAuthorizer();

    const agents = await authorizer.getPermissions({
      resourceType: 'agent',
      resourceIds,
      requestContext: CONTEXT,
      store: agentStore,
    });
    expect(Object.keys(agents)).toHaveLength(100);
    expect(agents[owned.id]).toEqual(['USE', 'MANAGE', 'DELETE']);

    const schedules = await authorizer.getPermissions({
      resourceType: 'schedule',
      resourceIds,
      requestContext: CONTEXT,
      store: new SqliteScheduleStore(db, atomic),
    });
    expect(Object.keys(schedules)).toHaveLength(100);

    const sessions = await authorizer.getPermissions({
      resourceType: 'session',
      resourceIds,
      requestContext: CONTEXT,
      store: new SqliteSessionStore(db, atomic),
    });
    expect(Object.keys(sessions)).toHaveLength(100);
    expectBoundedParameters();
  });
}
