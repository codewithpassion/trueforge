import {
  AgentSpecSchema,
  Sessions,
  type CreatedBySubject,
  type SessionHandle,
  type SessionSource,
  type TerminalTurnState,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import {
  makeCreateTurnInput,
  makeDoneTurnState,
  makeModelMessageEvent,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import type { IIntegrationStore } from '../../../src/db/integrationStore';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ScheduleRecord } from '../../../src/db/scheduleStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteIntegrationStore } from '../../../src/db/sqlite/integration-store/SqliteIntegrationStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { Database } from '../../../src/db/sqlite/types';
import { MAX_DELIVERY_ATTEMPTS } from '../../../src/integrations/deliverySchedule';
import { TurnCompletionNotifier } from '../../../src/integrations/TurnCompletionNotifier';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { startTurnInProcess, type BeginTurnExecutionDeps } from '../../../src/runtime/turnRunner';
import type { IntegrationManifest, IntegrationNotificationRule } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { ScriptedTurnSessions } from '../apis/scriptedSessions';
import { fakeChannelAdapter, type FakeChannelAdapter } from './fakeChannelAdapter';
import { seedAgent } from './seedAgent';

/** Notification rules only fire for schedule sessions, which these cases do not create. */
const scheduleStore = { getSchedule: (): Promise<undefined> => Promise.resolve(undefined) };

const TENANT = 'default';
const SESSION_ID = 's1';
const TURN_ID = 'turn-1';
const CONVERSATION_KEY = 'slack:T0TEAM:C0GENERAL:1700000000.000100';

const CREATED_BY: CreatedBySubject = {
  subject_id: 'admin-1',
  subject_type: 'user',
  subject_display_name: 'Admin One',
};

function manifest(): IntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'trueforge',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    approver_slack_user_ids: [],
    notification_rules: [],
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
  };
}

interface Harness {
  db: Kysely<Database>;
  sessionStore: SqliteSessionStore;
  integrationStore: IIntegrationStore<Kysely<Database>>;
  integrationId: string;
  /** The agent the integration is bound to. */
  agentId: string;
  turnStores: Pick<
    BeginTurnExecutionDeps,
    'agentStore' | 'modelProviderStore' | 'mcpServerStore' | 'sandboxProviderStore' | 'skillStore'
  >;
}

async function createHarness(options: { source?: SessionSource | null; external_id?: string } = {}): Promise<Harness> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const atomic = new BetterSqliteAtomicRunner(db);
  const sessionStore = new SqliteSessionStore(db, atomic);
  const integrationStore = new SqliteIntegrationStore(db, atomic);
  const integrationId = newId();
  const agent = await seedAgent({ db, tenant_id: TENANT, name: 'support-bot', created_by_subject: CREATED_BY });

  await integrationStore.createIntegration({
    id: integrationId,
    tenant_id: TENANT,
    agent_id: agent.id,
    agent_name: agent.name,
    type: 'slack',
    external_account_id: 'T0TEAM',
    manifest: manifest(),
    created_by_subject: CREATED_BY,
  });

  await sessionStore.createSession({
    tenant_id: TENANT,
    session_id: SESSION_ID,
    created_by_subject: CREATED_BY,
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }) },
    custom: null,
    metadata: {},
    external_id: options.external_id ?? CONVERSATION_KEY,
    source:
      options.source === undefined
        ? { type: 'integration', id: integrationId, conversation_key: CONVERSATION_KEY }
        : options.source,
  });
  await sessionStore.createTurn(makeCreateTurnInput({ sessionId: SESSION_ID, turnId: TURN_ID }));

  return {
    db,
    sessionStore,
    integrationStore,
    integrationId,
    agentId: agent.id,
    turnStores: {
      agentStore: new SqliteAgentStore(db),
      modelProviderStore: new SqliteModelProviderStore(db),
      mcpServerStore: new McpServerWithAuthStore({
        store: new SqliteMcpServerStore(db, atomic),
        tokenStore: new SqliteOAuthTokenStore(db),
        clientName: 'trueforge-tests',
      }),
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
      skillStore: new SqliteSkillStore(db),
    },
  };
}

/** Finishes the stored turn mid-stream, so the drain ends with a terminal turn like a real run. */
function scriptedSessions(harness: Harness): ScriptedTurnSessions {
  return new ScriptedTurnSessions({
    sessionStore: harness.sessionStore,
    turn_id: TURN_ID,
    events: async function* (): AsyncGenerator<TurnStreamingEvent> {
      yield makeModelMessageEvent();
      const state = makeDoneTurnState();
      await harness.sessionStore.updateTurnState({
        session_id: SESSION_ID,
        turn_id: TURN_ID,
        state,
        turn_done_event: makeTurnDoneEvent(state),
      });
    },
  });
}

async function runTurn(input: { harness: Harness; notifier: TurnCompletionNotifier<Kysely<Database>> }): Promise<void> {
  const session = await scriptedSessions(input.harness).get({ tenant_id: TENANT, session_id: SESSION_ID });
  if (session === undefined) {
    throw new Error('session was not created');
  }
  const { drained } = await startTurnInProcess({
    session,
    turn_id: TURN_ID,
    input: [{ type: 'user.message', content: 'hi' }],
    previous_turn_id: undefined,
    active_executor_id: 'test',
    userRef: CREATED_BY.subject_id,
    request_metadata: undefined,
    deps: {
      ...input.harness.turnStores,
      activeTurns: new ActiveTurnRegistry(),
      eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
      logger: createLogger({ silent: true }),
      sandboxIntegration: undefined,
      onTurnDrained: hookInput => input.notifier.deliverForTurn(hookInput),
    },
  });
  await drained;
}

function sessionHandle(harness: Harness): Promise<SessionHandle | undefined> {
  return new Sessions({ sessionStore: harness.sessionStore }).get({ tenant_id: TENANT, session_id: SESSION_ID });
}

describe('TurnCompletionNotifier on Node', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  it('delivers once after the drain settles, and not again', async () => {
    harness = await createHarness();
    const fake = fakeChannelAdapter();
    const notifier = new TurnCompletionNotifier({
      integrationStore: harness.integrationStore,
      scheduleStore,
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
      session_external_id: CONVERSATION_KEY,
      next_attempt_at: new Date(),
    });

    await runTurn({ harness, notifier });

    expect(fake.delivered).toHaveLength(1);
    expect(fake.delivered[0]).toMatchObject({ id: 'del-1', conversation_key: CONVERSATION_KEY, turn_id: TURN_ID });
    expect(
      await harness.integrationStore.getPendingDelivery({
        integration_id: harness.integrationId,
        turn_id: TURN_ID,
        conversation_key: CONVERSATION_KEY,
      }),
    ).toBeUndefined();

    // Re-running the hook finds nothing pending, so the conversation is not answered twice.
    const session = await sessionHandle(harness);
    if (session === undefined) {
      throw new Error('session was not created');
    }
    await notifier.deliverForTurn({ session, turn_id: TURN_ID });
    expect(fake.delivered).toHaveLength(1);
  });

  it('two flushes racing for one turn post exactly once', async () => {
    harness = await createHarness();
    const fake = fakeChannelAdapter();
    const notifier = new TurnCompletionNotifier({
      integrationStore: harness.integrationStore,
      scheduleStore,
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
      session_external_id: CONVERSATION_KEY,
      next_attempt_at: new Date(),
    });
    // Finish the turn first so both callers get past the terminal-state check together.
    const state = makeDoneTurnState();
    await harness.sessionStore.updateTurnState({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
    const session = await sessionHandle(harness);
    if (session === undefined) {
      throw new Error('session was not created');
    }

    // The drain hook and the router's post-start flush run in different isolates in production.
    await Promise.all(Array.from({ length: 4 }, () => notifier.deliverForTurn({ session, turn_id: TURN_ID })));

    expect(fake.delivered).toHaveLength(1);
    const [row] = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(row).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('records "no adapter" on the outbox row when the type has none registered', async () => {
    harness = await createHarness();
    const notifier = new TurnCompletionNotifier({
      integrationStore: harness.integrationStore,
      scheduleStore,
      adapters: new Map(),
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
      session_external_id: CONVERSATION_KEY,
      next_attempt_at: new Date(),
    });

    await runTurn({ harness, notifier });

    expect(
      await harness.integrationStore.getPendingDelivery({
        integration_id: harness.integrationId,
        turn_id: TURN_ID,
        conversation_key: CONVERSATION_KEY,
      }),
    ).toBeUndefined();
    const [row] = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: 'No adapter for integration type slack' });
  });

  it('a delivery failure puts the row back in the queue with its reason', async () => {
    harness = await createHarness();
    const fake = fakeChannelAdapter({ deliver: () => ({ ok: false, error: 'channel rejected the message' }) });
    const notifier = new TurnCompletionNotifier({
      integrationStore: harness.integrationStore,
      scheduleStore,
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
      session_external_id: CONVERSATION_KEY,
      next_attempt_at: new Date(),
    });

    await runTurn({ harness, notifier });

    const [row] = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'channel rejected the message' });
  });

  it('gives the row up once its attempts are spent', async () => {
    harness = await createHarness();
    const fake = fakeChannelAdapter({ deliver: () => ({ ok: false, error: 'channel rejected the message' }) });
    const notifier = new TurnCompletionNotifier({
      integrationStore: harness.integrationStore,
      scheduleStore,
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
      session_external_id: CONVERSATION_KEY,
      next_attempt_at: new Date(),
    });
    // Burn every attempt but the last, the way repeated sweeps would.
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS - 1; attempt += 1) {
      const claimed = await harness.integrationStore.claimDelivery({
        integration_id: harness.integrationId,
        turn_id: TURN_ID,
        conversation_key: CONVERSATION_KEY,
        next_attempt_at: new Date(),
      });
      await harness.integrationStore.releaseDelivery({
        id: claimed?.id ?? '',
        attempts: claimed?.attempts ?? 0,
        error: 'earlier failure',
        next_attempt_at: new Date(),
      });
    }

    await runTurn({ harness, notifier });

    const [row] = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(row).toMatchObject({
      status: 'failed',
      attempts: MAX_DELIVERY_ATTEMPTS,
      last_error: 'channel rejected the message',
    });
  });

  it('ignores a session that no integration owns', async () => {
    harness = await createHarness({ source: null });
    const fake = fakeChannelAdapter();
    const notifier = new TurnCompletionNotifier({
      integrationStore: harness.integrationStore,
      scheduleStore,
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
      session_external_id: CONVERSATION_KEY,
      next_attempt_at: new Date(),
    });

    await runTurn({ harness, notifier });

    expect(fake.delivered).toHaveLength(0);
    expect(
      await harness.integrationStore.getPendingDelivery({
        integration_id: harness.integrationId,
        turn_id: TURN_ID,
        conversation_key: CONVERSATION_KEY,
      }),
    ).toMatchObject({
      status: 'pending',
    });
  });
});

const SCHEDULE_ID = 'sched-1';
const RUN_ID = 'run-1';
const SCHEDULE_NAME = 'nightly-report';

/** Only the fields the notifier reads; the real record carries a manifest and timestamps. */
function scheduleStoreNamed(input: { name: string | undefined; agent_id: string }) {
  const { name } = input;
  return {
    getSchedule: (): Promise<ScheduleRecord | undefined> =>
      Promise.resolve(
        name === undefined
          ? undefined
          : {
              id: SCHEDULE_ID,
              tenant_id: TENANT,
              agent_id: input.agent_id,
              agent_name: 'support-bot',
              name,
              manifest: { task: 'report', cron: '0 0 * * *', timezone: 'UTC', status: 'active' },
              status: 'active',
              created_by_subject: CREATED_BY,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
      ),
  };
}

/** A schedule run's session: keyed by the run, not by any channel. */
async function scheduleHarness(input: { rules: IntegrationNotificationRule[]; connected?: boolean }): Promise<Harness> {
  const harness = await createHarness({
    source: { type: 'schedule', id: SCHEDULE_ID, run_id: RUN_ID },
    external_id: RUN_ID,
  });
  const base = manifest();
  await harness.integrationStore.updateIntegration({
    tenant_id: TENANT,
    id: harness.integrationId,
    external_account_id: 'T0TEAM',
    manifest:
      input.connected === false
        ? { ...base, team_id: undefined, bot_user_id: undefined, auth: undefined, notification_rules: input.rules }
        : { ...base, notification_rules: input.rules },
  });
  return harness;
}

/** Leaves the harness turn finished but waiting on a tool approval, the way a real pause looks. */
async function holdTurnOnApproval(harness: Harness): Promise<void> {
  const scope = { session_id: SESSION_ID, turn_id: TURN_ID };
  await harness.sessionStore.appendToEvents({
    ...scope,
    events: [
      {
        type: EventType.MODEL_MESSAGE,
        id: 'evt-model',
        thread_id: 'main',
        created_at: new Date().toISOString(),
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'restart_service', arguments: '{"service":"api"}' },
            tool_info: { type: 'truefoundry-system', name: 'restart_service' },
          },
        ],
      },
    ],
  });
  const state: TerminalTurnState = {
    status: 'done',
    output: null,
    required_actions: [
      {
        type: EventType.TOOL_APPROVAL_REQUIRED,
        id: 'evt-approval',
        created_at: new Date().toISOString(),
        thread_id: 'main',
        tool_calls: [{ id: 'call-1', source_event_id: 'evt-model' }],
      },
    ],
    completed_at: new Date().toISOString(),
  };
  await harness.sessionStore.updateTurnState({ ...scope, state, turn_done_event: makeTurnDoneEvent(state) });
}

function rule(overrides: Partial<IntegrationNotificationRule> = {}): IntegrationNotificationRule {
  return { schedule_name: SCHEDULE_NAME, channel_id: 'C0RELEASES', outcome: 'any', ...overrides };
}

describe('notification rules for a finished schedule run', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  /**
   * `scheduleName: null` stands for a schedule that has since been deleted. `scheduleAgentId`
   * defaults to the integration's own agent.
   */
  function notifierFor(input: {
    harness: Harness;
    fake: FakeChannelAdapter;
    scheduleName?: string | null;
    scheduleAgentId?: string;
  }) {
    const named = input.scheduleName === undefined ? SCHEDULE_NAME : input.scheduleName;
    return new TurnCompletionNotifier({
      integrationStore: input.harness.integrationStore,
      scheduleStore: scheduleStoreNamed({
        name: named === null ? undefined : named,
        agent_id: input.scheduleAgentId ?? input.harness.agentId,
      }),
      adapters: input.fake.adapters,
      logger: createLogger({ silent: true }),
    });
  }

  it('posts the run to the channel the rule names, at the top of it rather than in a thread', async () => {
    harness = await scheduleHarness({ rules: [rule()] });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake }) });

    expect(fake.delivered).toHaveLength(1);
    expect(fake.delivered[0]).toMatchObject({
      conversation_key: 'slack:T0TEAM:C0RELEASES:channel',
      turn_id: TURN_ID,
    });
    const [row] = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(row).toMatchObject({ status: 'sent', session_external_id: RUN_ID });
  });

  it('posts once per channel, however many rules point at it', async () => {
    harness = await scheduleHarness({
      rules: [rule(), rule({ outcome: 'success' }), rule({ channel_id: 'C0OPS' })],
    });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake }) });

    expect(fake.delivered.map(delivery => delivery.conversation_key).sort()).toEqual([
      'slack:T0TEAM:C0OPS:channel',
      'slack:T0TEAM:C0RELEASES:channel',
    ]);
  });

  it('ignores a rule for another schedule', async () => {
    harness = await scheduleHarness({ rules: [rule({ schedule_name: 'weekly-digest' })] });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake }) });

    expect(fake.delivered).toHaveLength(0);
  });

  it("ignores another agent's schedule of the same name", async () => {
    harness = await scheduleHarness({ rules: [rule()] });
    const other = await seedAgent({
      db: harness.db,
      tenant_id: TENANT,
      name: 'other-bot',
      created_by_subject: CREATED_BY,
    });
    const fake = fakeChannelAdapter();

    // Schedule names are unique per agent only, so agent B's `nightly-report` is not agent A's.
    await runTurn({ harness, notifier: notifierFor({ harness, fake, scheduleAgentId: other.id }) });

    expect(fake.delivered).toHaveLength(0);
    expect(await harness.db.selectFrom('integration_delivery').selectAll().execute()).toEqual([]);
  });

  it('honours an outcome filter: a successful run is not a failure', async () => {
    harness = await scheduleHarness({ rules: [rule({ outcome: 'failure' })] });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake }) });

    expect(fake.delivered).toHaveLength(0);
  });

  it('honours an outcome filter: a successful run matches a success rule', async () => {
    harness = await scheduleHarness({ rules: [rule({ outcome: 'success' })] });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake }) });

    expect(fake.delivered).toHaveLength(1);
  });

  it('posts nothing for an integration whose credentials are not saved', async () => {
    harness = await scheduleHarness({ rules: [rule()], connected: false });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake }) });

    expect(fake.delivered).toHaveLength(0);
    expect(await harness.db.selectFrom('integration_delivery').selectAll().execute()).toEqual([]);
  });

  it('posts nothing when the agent has no rules at all', async () => {
    harness = await scheduleHarness({ rules: [] });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake }) });

    expect(fake.delivered).toHaveLength(0);
  });

  it('posts nothing when the schedule the session names is gone', async () => {
    harness = await scheduleHarness({ rules: [rule()] });
    const fake = fakeChannelAdapter();

    await runTurn({ harness, notifier: notifierFor({ harness, fake, scheduleName: null }) });

    expect(fake.delivered).toHaveLength(0);
  });

  it('reports a held run rather than posting buttons a channel click could never resume', async () => {
    harness = await scheduleHarness({ rules: [rule()] });
    const fake = fakeChannelAdapter();
    const notifier = notifierFor({ harness, fake });

    // A rule posts to a channel, so a click there names a conversation the run was never keyed
    // by; buttons on it could not be resumed, and the run is reported as held instead.
    await holdTurnOnApproval(harness);
    const session = await sessionHandle(harness);
    if (session === undefined) {
      throw new Error('session was not created');
    }
    await notifier.deliverForTurn({ session, turn_id: TURN_ID });

    expect(fake.delivered.map(delivery => delivery.content.type)).toEqual(['status']);
  });

  it('does not report a held run as a success, because it has finished nothing', async () => {
    harness = await scheduleHarness({ rules: [rule({ outcome: 'success' })] });
    const fake = fakeChannelAdapter();
    const notifier = notifierFor({ harness, fake });

    await holdTurnOnApproval(harness);
    const session = await sessionHandle(harness);
    if (session === undefined) {
      throw new Error('session was not created');
    }
    await notifier.deliverForTurn({ session, turn_id: TURN_ID });

    expect(fake.delivered).toHaveLength(0);
  });

  it('a second pass over the same turn posts nothing more', async () => {
    harness = await scheduleHarness({ rules: [rule()] });
    const fake = fakeChannelAdapter();
    const notifier = notifierFor({ harness, fake });

    await runTurn({ harness, notifier });
    const session = await sessionHandle(harness);
    if (session === undefined) {
      throw new Error('session was not created');
    }
    await notifier.deliverForTurn({ session, turn_id: TURN_ID });

    expect(fake.delivered).toHaveLength(1);
  });
});
