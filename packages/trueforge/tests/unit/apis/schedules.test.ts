import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, InMemorySessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { createLogger } from 'winston';
import { createScheduleExecutionRouter, createSchedulesRouter } from '../../../src/apis/schedules';
import { createAppErrorHandler } from '../../../src/app';
import { TrueForgeAuthorizer, type Authorizer } from '../../../src/auth/authorizer';
import type { RequestContext } from '../../../src/auth/identity';
import { ScheduleAgentNotFoundError, startScheduleRun } from '../../../src/controller/scheduleDispatch';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import {
  CreateScheduleRunResponseSchema,
  ListScheduleRunsResponseSchema,
  ListSchedulesResponseSchema,
} from '../../../src/schemas/schedule';
import { testNodeTurnExecutor } from '../runtime/testNodeTurnExecutor';

jest.mock('../../../src/controller/scheduleDispatch', () => {
  const actual = jest.requireActual<typeof import('../../../src/controller/scheduleDispatch')>(
    '../../../src/controller/scheduleDispatch',
  );
  return {
    ...actual,
    startScheduleRun: jest.fn().mockResolvedValue(undefined),
  };
});

const mockedStartScheduleRun = startScheduleRun as jest.MockedFunction<typeof startScheduleRun>;

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};
const BOB: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'bob', type: 'user', display_name: 'bob' },
  roles: [],
  user_credential: null,
};
const ADMIN: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'root', type: 'user', display_name: 'root' },
  roles: ['admin'],
  user_credential: null,
};

const scheduleBody = {
  agent_name: 'reporter',
  name: 'daily-report',
  manifest: { task: 'Say hi', cron: '0 13 * * *', timezone: 'UTC' },
};

function stubTurnExecutionDeps(agentStore: SqliteAgentStore, scheduleStore: SqliteScheduleStore) {
  const sessionStore = new InMemorySessionStore();
  return {
    scheduleStore,
    sessions: new Sessions({ sessionStore }),
    agentStore,
    turnExecutor: testNodeTurnExecutor(),
    resolveModelProviderStore: () => ({}) as never,
    resolveMcpServerStore: () => ({}) as never,
    turnSkillsResolverStore: { resolveTurnSkills: async () => [] },
    resolveSandboxProviderStore: () => ({}) as never,
  };
}

async function setup(authorizer: Authorizer = new TrueForgeAuthorizer()) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const scheduleStore = new SqliteScheduleStore(db, new BetterSqliteAtomicRunner(db));
  await agentStore.createAgent({
    tenant_id: 'default',
    created_by_subject: {
      subject_id: 'alice',
      subject_type: 'user',
      subject_display_name: 'alice',
    },
    name: 'reporter',
    description: 'Test agent.',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    external_id: 'reporter-external-id',
  });

  let current: RequestContext = ALICE;
  let currentAuthorizer = authorizer;
  mockedStartScheduleRun.mockReset();
  mockedStartScheduleRun.mockResolvedValue(undefined);
  const app = new OpenAPIHono();
  app.route(
    '/',
    createSchedulesRouter({
      ...stubTurnExecutionDeps(agentStore, scheduleStore),
      resolveAgentStore: () => agentStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveRequestContext: () => current,
      authorizer: {
        listAgentAccess: input => currentAuthorizer.listAgentAccess(input),
        canAccessAgent: input => currentAuthorizer.canAccessAgent(input),
        getPermissions: input => currentAuthorizer.getPermissions(input),
      },
    }),
  );

  const asUser = (user: RequestContext) => {
    current = user;
  };
  const setAuthorizer = (next: Authorizer) => {
    currentAuthorizer = next;
  };
  const postJson = (path: string, method: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return { app, asUser, setAuthorizer, postJson, agentStore, scheduleStore };
}

describe('schedule RBAC', () => {
  it("hides another user's schedule from get, update, delete, list, and run trigger", async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    asUser(BOB);
    expect((await app.request(`/${id}`)).status).toBe(403);
    expect((await postJson(`/${id}`, 'PUT', { name: 'renamed', manifest: scheduleBody.manifest })).status).toBe(403);
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(403);

    const bobList = await app.request('/');
    expect(bobList.status).toBe(200);
    expect(ListSchedulesResponseSchema.parse(await bobList.json()).data).toEqual([]);

    expect((await app.request(`/${id}/runs`)).status).toBe(403);
    expect((await postJson('/runs', 'POST', { schedule_id: id })).status).toBe(403);
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();
  });

  it('lets the creator see and manage their own schedule', async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    expect((await app.request(`/${id}`)).status).toBe(200);
    const aliceList = await app.request('/');
    expect(ListSchedulesResponseSchema.parse(await aliceList.json()).data).toHaveLength(1);
    const aliceRuns = await app.request(`/${id}/runs`);
    expect(aliceRuns.status).toBe(200);
    const aliceRunsBody = ListScheduleRunsResponseSchema.parse(await aliceRuns.json());
    expect(aliceRunsBody.data).toEqual([expect.objectContaining({ schedule_id: id })]);
    expect(aliceRunsBody.pagination.next_page_token).toBeUndefined();
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('rejects an invalid page_token when listing runs', async () => {
    const { app, asUser, postJson } = await setup();
    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    const res = await app.request(`/${id}/runs?page_token=not-a-token`);
    expect(res.status).toBe(400);
  });

  it('does not leak existence: a missing schedule is 404, not 403', async () => {
    const { app, asUser, postJson } = await setup();
    asUser(BOB);
    expect((await app.request('/01jqzz000000000000000nope')).status).toBe(404);
    expect((await app.request('/01jqzz000000000000000nope/runs')).status).toBe(404);
    expect((await postJson('/runs', 'POST', { schedule_id: '01jqzz000000000000000nope' })).status).toBe(404);
  });

  it("does not let an OIDC settings admin access another user's schedule", async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    asUser(ADMIN);
    expect((await app.request(`/${id}`)).status).toBe(403);
    const adminList = await app.request('/');
    expect(ListSchedulesResponseSchema.parse(await adminList.json()).data).toEqual([]);
    expect((await app.request(`/${id}/runs`)).status).toBe(403);
    expect((await postJson(`/${id}`, 'PUT', { name: 'admin-renamed', manifest: scheduleBody.manifest })).status).toBe(
      403,
    );
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await postJson('/runs', 'POST', { schedule_id: id })).status).toBe(403);
  });

  it('lets an agent manager read schedules and runs but keeps mutations creator-only', async () => {
    const { app, asUser, setAuthorizer, postJson } = await setup();
    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    setAuthorizer({
      listAgentAccess: input =>
        Promise.resolve(
          input.action === 'manage'
            ? { kind: 'agent_external_ids', agent_external_ids: ['reporter-external-id'] }
            : { kind: 'agent_external_ids', agent_external_ids: [] },
        ),
      canAccessAgent: () => Promise.resolve(false),
      getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
    });
    asUser(BOB);
    expect((await app.request(`/${id}`)).status).toBe(200);
    expect(ListSchedulesResponseSchema.parse(await (await app.request('/')).json()).data).toHaveLength(1);
    expect(
      ListSchedulesResponseSchema.parse(await (await app.request('/?created_by_me=true')).json()).data,
    ).toHaveLength(0);
    expect(ListScheduleRunsResponseSchema.parse(await (await app.request(`/${id}/runs`)).json()).data).toHaveLength(1);
    expect((await postJson(`/${id}`, 'PUT', { name: 'renamed', manifest: scheduleBody.manifest })).status).toBe(403);
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await postJson('/runs', 'POST', { schedule_id: id })).status).toBe(403);

    asUser(ALICE);
    expect(
      ListSchedulesResponseSchema.parse(await (await app.request('/?created_by_me=true')).json()).data.map(
        row => row.id,
      ),
    ).toEqual([id]);
  });
});

describe('schedule list agent_names filter', () => {
  it('filters by a single agent_names value and by comma-separated agent_names', async () => {
    const { app, asUser, agentStore, postJson } = await setup();
    await agentStore.createAgent({
      tenant_id: 'default',
      created_by_subject: {
        subject_id: 'alice',
        subject_type: 'user',
        subject_display_name: 'alice',
      },
      name: 'reporter-two',
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      external_id: null,
    });

    asUser(ALICE);
    const aliceCreated = await postJson('/', 'POST', scheduleBody);
    const aliceId = ((await aliceCreated.json()) as { data: { id: string } }).data.id;
    const secondCreated = await postJson('/', 'POST', {
      ...scheduleBody,
      agent_name: 'reporter-two',
      name: 'daily-report-two',
    });
    const secondId = ((await secondCreated.json()) as { data: { id: string } }).data.id;

    const single = await app.request('/?agent_names=reporter');
    expect(single.status).toBe(200);
    expect(ListSchedulesResponseSchema.parse(await single.json()).data.map(row => row.id)).toEqual([aliceId]);

    const multi = await app.request('/?agent_names=reporter,reporter-two');
    expect(multi.status).toBe(200);
    expect(
      ListSchedulesResponseSchema.parse(await multi.json())
        .data.map(row => row.id)
        .sort(),
    ).toEqual([aliceId, secondId].sort());

    const withGaps = await app.request('/?agent_names=reporter,,reporter-two');
    expect(withGaps.status).toBe(200);
    expect(
      ListSchedulesResponseSchema.parse(await withGaps.json())
        .data.map(row => row.id)
        .sort(),
    ).toEqual([aliceId, secondId].sort());

    const omitted = await app.request('/');
    expect(ListSchedulesResponseSchema.parse(await omitted.json()).data).toHaveLength(2);

    // Present but empty / comma-only values fail validation.
    for (const query of ['/?agent_names=', '/?agent_names=,,,', '/?agent_names=%20,%20']) {
      const empty = await app.request(query);
      expect(empty.status).toBe(400);
    }
  });
});

describe('create schedule run', () => {
  it('creates a triggered run with a manual-* name and leaves the cron pending run alone', async () => {
    const { asUser, postJson, scheduleStore } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    const pendingBefore = await scheduleStore.getScheduledRunFor({ tenant_id: 'default', schedule_id: scheduleId });
    expect(pendingBefore?.status).toBe('scheduled');

    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(201);
    const body = CreateScheduleRunResponseSchema.parse(await res.json());
    expect(body.data).toEqual(
      expect.objectContaining({
        schedule_id: scheduleId,
        status: 'triggered',
        reason: null,
        created_by_subject: {
          subject_id: 'alice',
          subject_type: 'user',
          subject_display_name: 'alice',
        },
        name: expect.stringMatching(/^manual-/),
      }),
    );
    expect(body.data.triggered_at).not.toBeNull();

    expect(mockedStartScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ run: expect.objectContaining({ id: body.data.id }) }),
      }),
    );

    const pendingAfter = await scheduleStore.getScheduledRunFor({ tenant_id: 'default', schedule_id: scheduleId });
    expect(pendingAfter?.id).toBe(pendingBefore?.id);
    expect(pendingAfter?.status).toBe('scheduled');

    const runs = await scheduleStore.listRuns({
      tenant_id: 'default',
      schedule_id: scheduleId,
      limit: 25,
      page_token: undefined,
    });
    expect(runs.data.map(r => r.status).sort()).toEqual(['scheduled', 'triggered']);
  });

  it('does not let an OIDC settings admin trigger another creator schedule', async () => {
    const { asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    asUser(ADMIN);
    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(403);
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();
  });

  it('marks the run failed and returns 404 when startScheduleRun reports a missing agent', async () => {
    const { asUser, postJson, scheduleStore } = await setup();
    mockedStartScheduleRun.mockRejectedValue(new ScheduleAgentNotFoundError('reporter'));

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Agent not found: reporter');

    const runs = await scheduleStore.listRuns({
      tenant_id: 'default',
      schedule_id: scheduleId,
      limit: 25,
      page_token: undefined,
    });
    const runNow = runs.data.find(r => r.name.startsWith('manual-'));
    expect(runNow?.status).toBe('failed');
    expect(runNow?.reason).toBe('Agent not found: reporter');
  });

  it('returns 404 when creating a schedule for an agent the caller cannot use', async () => {
    const canAccessAgent = jest.fn((_input: Parameters<Authorizer['canAccessAgent']>[0]) => Promise.resolve(false));
    const denyAll: Authorizer = {
      listAgentAccess: () => Promise.resolve({ kind: 'agent_external_ids', agent_external_ids: [] }),
      canAccessAgent,
      getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
    };
    const { postJson } = await setup(denyAll);
    const res = await postJson('/', 'POST', scheduleBody);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Agent not found: reporter');
    expect(canAccessAgent.mock.calls.map(([input]) => input.action)).toEqual(['use']);
  });

  it('returns 404 on run-now when the caller can access the schedule but not the agent', async () => {
    const { asUser, setAuthorizer, postJson, scheduleStore } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    const canAccessAgent = jest.fn((_input: Parameters<Authorizer['canAccessAgent']>[0]) => Promise.resolve(false));
    setAuthorizer({
      listAgentAccess: () => Promise.resolve({ kind: 'agent_external_ids', agent_external_ids: [] }),
      canAccessAgent,
      getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
    });

    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Agent not found: reporter');
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();

    const runs = await scheduleStore.listRuns({
      tenant_id: 'default',
      schedule_id: scheduleId,
      limit: 25,
      page_token: undefined,
    });
    expect(runs.data.some(r => r.name.startsWith('manual-'))).toBe(false);
    expect(canAccessAgent.mock.calls.map(([input]) => input.action)).toEqual(['use']);
  });
});

describe('internal schedule execution', () => {
  it('executes the persisted run id', async () => {
    mockedStartScheduleRun.mockReset();
    mockedStartScheduleRun.mockResolvedValue(undefined);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const agentStore = new SqliteAgentStore(db);
    const scheduleStore = new SqliteScheduleStore(db, new BetterSqliteAtomicRunner(db));
    const agent = await agentStore.createAgent({
      tenant_id: 'default',
      created_by_subject: {
        subject_id: 'alice',
        subject_type: 'user',
        subject_display_name: 'alice',
      },
      name: 'reporter',
      description: 'reporter description',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      external_id: 'reporter-external-id',
    });
    const { schedule } = await scheduleStore.createScheduleAndRun({
      tenant_id: 'default',
      agent_id: agent.id,
      agent_name: agent.name,
      name: 'daily-report',
      manifest: { task: 'Say hi', cron: '0 13 * * *', timezone: 'UTC', status: 'active' },
      created_by_subject: {
        subject_id: 'alice',
        subject_type: 'user',
        subject_display_name: 'alice',
      },
      runFrom: new Date(),
    });
    const run = await scheduleStore.createRun({
      tenant_id: 'default',
      schedule_id: schedule.id,
      name: 'manual-test',
      scheduled_for: new Date(),
      status: 'triggered',
      created_by_subject: {
        subject_id: 'alice',
        subject_type: 'user',
        subject_display_name: 'alice',
      },
      triggered_at: new Date(),
    });
    const app = createScheduleExecutionRouter(stubTurnExecutionDeps(agentStore, scheduleStore));

    const response = await app.request('/runs/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule_run_id: run.id }),
    });

    expect(response.status).toBe(204);
    expect(mockedStartScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ run: expect.objectContaining({ id: run.id }) }) }),
    );
  });

  it('answers 422 when the turn cannot start because the agent needs a sandbox', async () => {
    const actual = jest.requireActual<typeof import('../../../src/controller/scheduleDispatch')>(
      '../../../src/controller/scheduleDispatch',
    );
    mockedStartScheduleRun.mockReset();
    mockedStartScheduleRun.mockImplementation(actual.startScheduleRun);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const agentStore = new SqliteAgentStore(db);
    const scheduleStore = new SqliteScheduleStore(db, new BetterSqliteAtomicRunner(db));
    const modelProviderStore = new SqliteModelProviderStore(db);
    await modelProviderStore.upsertProvider({
      tenant_id: 'default',
      name: 'test-provider',
      manifest: {
        type: 'custom',
        name: 'test-provider',
        base_url: 'https://llm.test.example.com/v1',
        auth: { api_key: 'sk-test' },
        models: [
          {
            model_id: 'test-model',
            name: 'test-model',
            properties: { context_length: 128000, max_output_tokens: 4096 },
          },
        ],
      },
    });
    const alice = { subject_id: 'alice', subject_type: 'user' as const, subject_display_name: 'alice' };
    const agent = await agentStore.createAgent({
      tenant_id: 'default',
      created_by_subject: alice,
      name: 'sandboxed',
      description: 'Needs a sandbox.',
      manifest: AgentSpecSchema.parse({
        model: { name: 'test-provider/test-model' },
        instructions: 'test',
        config: { sandbox: { enabled: true } },
      }),
      external_id: null,
    });
    const { schedule } = await scheduleStore.createScheduleAndRun({
      tenant_id: 'default',
      agent_id: agent.id,
      agent_name: agent.name,
      name: 'sandboxed-report',
      manifest: { task: 'Say hi', cron: '0 13 * * *', timezone: 'UTC', status: 'active' },
      created_by_subject: alice,
      runFrom: new Date(),
    });
    const run = await scheduleStore.createRun({
      tenant_id: 'default',
      schedule_id: schedule.id,
      name: 'manual-sandboxed',
      scheduled_for: new Date(),
      status: 'triggered',
      created_by_subject: alice,
      triggered_at: new Date(),
    });
    const tokenStore = new SqliteOAuthTokenStore(db);
    // Behind the server's error handler, which renders the route's HTTPException as the error envelope.
    const app = new OpenAPIHono();
    app.onError(createAppErrorHandler({ logger: createLogger({ silent: true }) }));
    const executionRouter = createScheduleExecutionRouter({
      ...stubTurnExecutionDeps(agentStore, scheduleStore),
      sessions: new Sessions({ sessionStore: new SqliteSessionStore(db, new BetterSqliteAtomicRunner(db)) }),
      turnExecutor: testNodeTurnExecutor({ sandboxIntegration: undefined }),
      resolveModelProviderStore: () => modelProviderStore,
      resolveMcpServerStore: () =>
        new McpServerWithAuthStore({
          store: new SqliteMcpServerStore(db, new BetterSqliteAtomicRunner(db)),
          tokenStore,
          clientName: 'test-client',
        }),
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
      turnSkillsResolverStore: new SqliteSkillStore(db),
    });
    app.route('/', executionRouter);

    const response = await app.request('/runs/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule_run_id: run.id }),
    });

    const message = 'no sandbox provider configured — PUT /settings/sandbox-providers';
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { message } });
    // The route leaves the run alone; the dispatch loop marks it failed from the non-2xx answer. The fixture
    // run is `triggered` only to show the row is untouched: in the real dispatch loop the run is still
    // `scheduled` at execute time and the controller records the failure afterwards.
    expect(await scheduleStore.getRun({ tenant_id: 'default', id: run.id })).toMatchObject({
      status: 'triggered',
      reason: null,
    });
  });

  it('maps an unknown run to 404', async () => {
    mockedStartScheduleRun.mockReset();
    mockedStartScheduleRun.mockResolvedValue(undefined);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const agentStore = new SqliteAgentStore(db);
    const scheduleStore = new SqliteScheduleStore(db, new BetterSqliteAtomicRunner(db));
    const app = createScheduleExecutionRouter(stubTurnExecutionDeps(agentStore, scheduleStore));

    const response = await app.request('/runs/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule_run_id: 'missing' }),
    });

    expect(response.status).toBe(404);
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();
  });
});
