import {
  AgentSpecSchema,
  CancellationReason,
  Sessions,
  type CreatedBySubject,
} from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import type { IIntegrationStore, IntegrationRecord } from '../../../src/db/integrationStore';
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
import { BUSY_CONVERSATION_NOTICE, IntegrationRouter } from '../../../src/integrations/router';
import { TurnCompletionNotifier } from '../../../src/integrations/TurnCompletionNotifier';
import type { InboundEvent } from '../../../src/integrations/types';
import type { IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { fakeChannelAdapter, type FakeChannelAdapter } from './fakeChannelAdapter';
import { RecordingTurnExecutor } from './recordingTurnExecutor';

const TENANT = 'default';
const AGENT_NAME = 'support-bot';

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
    default_agent_name: AGENT_NAME,
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
  };
}

function inboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    integration_id: 'unused',
    conversation_key: 'slack:T0TEAM:C0GENERAL:1700000000.000100',
    sender: { id: 'U0HUMAN', display_name: 'Ada' },
    text: 'what is the status?',
    attachment_urls: [],
    event_id: 'Ev0001',
    ...overrides,
  };
}

interface Harness {
  db: Kysely<Database>;
  integrationStore: IIntegrationStore<Kysely<Database>>;
  integration: IntegrationRecord;
  router: IntegrationRouter<Kysely<Database>>;
  channel: FakeChannelAdapter;
  executor: RecordingTurnExecutor;
  sessions: Sessions;
  /** Awaits the flushes the router handed to `deferDelivery`, which a request would not wait on. */
  flush: () => Promise<void>;
}

async function createHarness(options: { withAgent?: boolean } = {}): Promise<Harness> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const atomic = new BetterSqliteAtomicRunner(db);
  const sessionStore = new SqliteSessionStore(db, atomic);
  const agentStore = new SqliteAgentStore(db);
  const integrationStore = new SqliteIntegrationStore(db, atomic);

  if (options.withAgent !== false) {
    await agentStore.createAgent({
      tenant_id: TENANT,
      name: AGENT_NAME,
      description: AGENT_NAME,
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
      external_id: null,
      created_by_subject: CREATED_BY,
    });
  }

  const integration = await integrationStore.createIntegration({
    id: newId(),
    tenant_id: TENANT,
    type: 'slack',
    external_account_id: 'T0TEAM',
    manifest: manifest(),
    created_by_subject: CREATED_BY,
  });

  const logger = createLogger({ silent: true });
  const channel = fakeChannelAdapter();
  const sessions = new Sessions({ sessionStore });
  const executor = new RecordingTurnExecutor(sessionStore);
  const deferred: Promise<void>[] = [];
  const router = new IntegrationRouter({
    deferDelivery: run => {
      deferred.push(run());
    },
    integrationStore,
    sessions,
    agentStore,
    turnExecutor: executor,
    // The recording executor ignores these; the real stores keep the shape honest.
    resolveTurnStores: () => ({
      agentStore,
      modelProviderStore: new SqliteModelProviderStore(db),
      mcpServerStore: new McpServerWithAuthStore({
        store: new SqliteMcpServerStore(db, atomic),
        tokenStore: new SqliteOAuthTokenStore(db),
        clientName: 'trueforge-tests',
      }),
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
      skillStore: new SqliteSkillStore(db),
    }),
    notifier: new TurnCompletionNotifier({
      integrationStore,
      adapters: channel.adapters,
      logger,
    }),
    logger,
  });
  return {
    db,
    integrationStore,
    integration,
    router,
    channel,
    executor,
    sessions,
    flush: async () => {
      await Promise.all(deferred.splice(0));
    },
  };
}

/** Ends the conversation's running turn, so the next message is not answered as busy. */
async function settleTurn(harness: Harness, turnId: string): Promise<void> {
  const session = await harness.sessions.getByExternalId({
    tenant_id: TENANT,
    external_id: inboundEvent().conversation_key,
  });
  await session?.freezeTurn({ turn_id: turnId, reason: CancellationReason.CancelledForNextTurn });
}

describe('IntegrationRouter', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  it('starts one turn for an event and records the reply owed', async () => {
    harness = await createHarness();
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });

    expect(routed).toMatchObject({ type: 'started' });
    expect(harness.executor.starts).toHaveLength(1);
    expect(harness.executor.starts[0]).toMatchObject({
      previous_turn_id: 'auto',
      userRef: CREATED_BY.subject_id,
      input: [{ type: 'user.message', content: 'what is the status?' }],
    });

    if (routed.type !== 'started') {
      throw new Error('expected the turn to start');
    }
    const delivery = await harness.integrationStore.getPendingDelivery({ turn_id: routed.turn_id });
    expect(delivery).toMatchObject({
      integration_id: harness.integration.id,
      conversation_key: inboundEvent().conversation_key,
      status: 'pending',
    });
  });

  it('binds the session to the conversation and records the sender', async () => {
    harness = await createHarness();
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (routed.type !== 'started') {
      throw new Error('expected the turn to start');
    }

    const session = harness.executor.starts[0]?.session;
    expect(session?.record.external_id).toBe(inboundEvent().conversation_key);
    expect(session?.record.source).toEqual({
      type: 'integration',
      id: harness.integration.id,
      conversation_key: inboundEvent().conversation_key,
    });
    expect(session?.record.metadata).toEqual({
      'integration.sender_id': 'U0HUMAN',
      'integration.sender_name': 'Ada',
    });
    expect(session?.record.created_by_subject).toEqual(CREATED_BY);
  });

  it('the same event id twice starts one turn and writes one outbox row', async () => {
    harness = await createHarness();
    const first = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    const second = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });

    expect(first.type).toBe('started');
    expect(second).toEqual({ type: 'duplicate' });
    expect(harness.executor.starts).toHaveLength(1);

    const deliveries = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(deliveries).toHaveLength(1);
  });

  it('a second message in the same conversation continues the session and adds its own outbox row', async () => {
    harness = await createHarness();
    const first = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (first.type !== 'started') {
      throw new Error('expected the first turn to start');
    }
    await settleTurn(harness, first.turn_id);

    const second = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent({ event_id: 'Ev0002', text: 'any update?' }),
    });
    if (second.type !== 'started') {
      throw new Error('expected the second turn to start');
    }
    expect(second.session_id).toBe(first.session_id);
    expect(second.turn_id).not.toBe(first.turn_id);
    expect(harness.channel.notices).toEqual([]);

    const deliveries = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(deliveries).toHaveLength(2);
  });

  it('answers a busy thread in the channel instead of starting a second turn', async () => {
    harness = await createHarness();
    const first = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (first.type !== 'started') {
      throw new Error('expected the first turn to start');
    }

    const second = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent({ event_id: 'Ev0002', text: 'any update?' }),
    });
    await harness.flush();

    expect(second).toEqual({ type: 'busy', running_turn_id: first.turn_id });
    expect(harness.executor.starts).toHaveLength(1);
    expect(harness.channel.notices).toEqual([BUSY_CONVERSATION_NOTICE]);
    // The message was answered, so its dedupe row stays and a channel retry does not repeat the notice.
    expect(await harness.db.selectFrom('integration_delivery').selectAll().execute()).toHaveLength(1);
    expect(await harness.db.selectFrom('integration_event').selectAll().execute()).toHaveLength(2);
  });

  it('reports a missing agent without starting a turn, and releases the event', async () => {
    harness = await createHarness({ withAgent: false });
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });

    expect(routed).toEqual({ type: 'agent_not_found', agent_name: AGENT_NAME });
    expect(harness.executor.starts).toHaveLength(0);
    // Nothing ran, so the channel's retry of the same event id must not look like a replay.
    expect(await harness.db.selectFrom('integration_event').selectAll().execute()).toEqual([]);
  });

  it('releases the event when the turn cannot start, so the channel retry runs it', async () => {
    harness = await createHarness();
    harness.executor.failNextStart({
      ok: false,
      status: 409,
      code: 'previous_turn_running',
      message: 'previous turn is running',
    });

    const first = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    expect(first).toMatchObject({ type: 'turn_failed' });
    expect(await harness.db.selectFrom('integration_event').selectAll().execute()).toEqual([]);

    // The retry is a fresh event as far as dedupe is concerned, so the message is not lost.
    const retry = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    expect(retry.type).toBe('started');
    expect(harness.executor.starts).toHaveLength(2);
  });

  it("keeps the post-start flush out of the caller's path", async () => {
    harness = await createHarness();
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (routed.type !== 'started') {
      throw new Error('expected the turn to start');
    }

    // route() returned without waiting on delivery; the row is still owed until the flush runs.
    expect(await harness.integrationStore.getPendingDelivery({ turn_id: routed.turn_id })).toBeDefined();
    await harness.flush();
  });
});
