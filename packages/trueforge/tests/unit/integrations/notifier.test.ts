import {
  AgentSpecSchema,
  Sessions,
  type CreatedBySubject,
  type SessionHandle,
  type SessionSource,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
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
import { MAX_DELIVERY_ATTEMPTS, TurnCompletionNotifier } from '../../../src/integrations/TurnCompletionNotifier';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { startTurnInProcess, type BeginTurnExecutionDeps } from '../../../src/runtime/turnRunner';
import type { IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { ScriptedTurnSessions } from '../apis/scriptedSessions';
import { fakeChannelAdapter } from './fakeChannelAdapter';

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
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    default_agent_name: 'support-bot',
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
  };
}

interface Harness {
  db: Kysely<Database>;
  sessionStore: SqliteSessionStore;
  integrationStore: IIntegrationStore<Kysely<Database>>;
  integrationId: string;
  turnStores: Pick<
    BeginTurnExecutionDeps,
    'agentStore' | 'modelProviderStore' | 'mcpServerStore' | 'sandboxProviderStore' | 'skillStore'
  >;
}

async function createHarness(options: { source?: SessionSource | null } = {}): Promise<Harness> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const atomic = new BetterSqliteAtomicRunner(db);
  const sessionStore = new SqliteSessionStore(db, atomic);
  const integrationStore = new SqliteIntegrationStore(db, atomic);
  const integrationId = newId();

  await integrationStore.createIntegration({
    id: integrationId,
    tenant_id: TENANT,
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
    external_id: CONVERSATION_KEY,
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
    userRef: CREATED_BY.subject_id,
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
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
    });

    await runTurn({ harness, notifier });

    expect(fake.delivered).toHaveLength(1);
    expect(fake.delivered[0]).toMatchObject({ id: 'del-1', conversation_key: CONVERSATION_KEY, turn_id: TURN_ID });
    expect(await harness.integrationStore.getPendingDelivery({ turn_id: TURN_ID })).toBeUndefined();

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
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
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
      adapters: new Map(),
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
    });

    await runTurn({ harness, notifier });

    expect(await harness.integrationStore.getPendingDelivery({ turn_id: TURN_ID })).toBeUndefined();
    const [row] = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: 'No adapter for integration type slack' });
  });

  it('a delivery failure puts the row back in the queue with its reason', async () => {
    harness = await createHarness();
    const fake = fakeChannelAdapter({ deliver: () => ({ ok: false, error: 'channel rejected the message' }) });
    const notifier = new TurnCompletionNotifier({
      integrationStore: harness.integrationStore,
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
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
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
    });
    // Burn every attempt but the last, the way repeated sweeps would.
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS - 1; attempt += 1) {
      const claimed = await harness.integrationStore.claimDelivery({ turn_id: TURN_ID });
      await harness.integrationStore.releaseDelivery({
        id: claimed?.id ?? '',
        attempts: claimed?.attempts ?? 0,
        error: 'earlier failure',
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
      adapters: fake.adapters,
      logger: createLogger({ silent: true }),
    });
    await harness.integrationStore.enqueueDelivery({
      id: 'del-1',
      tenant_id: TENANT,
      integration_id: harness.integrationId,
      conversation_key: CONVERSATION_KEY,
      turn_id: TURN_ID,
    });

    await runTurn({ harness, notifier });

    expect(fake.delivered).toHaveLength(0);
    expect(await harness.integrationStore.getPendingDelivery({ turn_id: TURN_ID })).toMatchObject({
      status: 'pending',
    });
  });
});
