import {
  AgentSpecSchema,
  CancellationReason,
  Sessions,
  type CreatedBySubject,
  type TerminalTurnState,
} from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import { makeTurnDoneEvent } from '../../../../trueforge-core/tests/agent-session/testHelpers';
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
import { ASK_USER_QUESTION_TOOL } from '../../../src/integrations/pendingActions';
import { BUSY_CONVERSATION_NOTICE, IntegrationRouter } from '../../../src/integrations/router';
import { TurnCompletionNotifier } from '../../../src/integrations/TurnCompletionNotifier';
import type {
  InboundEvent,
  InboundInteraction,
  InboundSender,
  InteractionDecision,
} from '../../../src/integrations/types';
import type { IntegrationManifest } from '../../../src/schemas/integration';
import { newId } from '../../../src/utils/id';
import { fakeChannelAdapter, type FakeChannelAdapter } from './fakeChannelAdapter';
import { RecordingTurnExecutor } from './recordingTurnExecutor';

/** Notification rules only fire for schedule sessions, which these cases do not create. */
const scheduleStore = { getSchedule: (): Promise<undefined> => Promise.resolve(undefined) };

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
    approver_slack_user_ids: [],
    notification_rules: [],
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

/** The tool calls a held turn in these cases is waiting on. */
const APPROVAL_CALL_ID = 'call-approve';
const QUESTION_CALL_ID = 'call-question';
const MODEL_EVENT_ID = 'evt-model';

const APPROVER: InboundSender = { id: 'U0ADMIN', display_name: 'Admin' };

function interaction(overrides: {
  turn_id: string;
  tool_call_id?: string;
  decision?: InteractionDecision;
  sender?: InboundSender;
}): InboundInteraction {
  return {
    integration_id: 'unused',
    conversation_key: inboundEvent().conversation_key,
    sender: overrides.sender ?? APPROVER,
    turn_id: overrides.turn_id,
    tool_call_id: overrides.tool_call_id ?? APPROVAL_CALL_ID,
    decision: overrides.decision ?? { type: 'approval', approved: true },
    reply_context: 'https://hooks.slack.com/actions/T0TEAM/1/abc',
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
  /** Leaves a started turn finished but waiting on a human, the way a real pause looks. */
  holdTurn: (input: { turn_id: string; held: 'approval' | 'question' }) => Promise<void>;
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
      scheduleStore,
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
    holdTurn: async input => {
      const session = await sessions.getByExternalId({
        tenant_id: TENANT,
        external_id: inboundEvent().conversation_key,
      });
      if (session === undefined) {
        throw new Error('the conversation has no session to hold');
      }
      const scope = { session_id: session.session_id, turn_id: input.turn_id };
      // The call's name and arguments live on the model message the required action points at.
      await sessionStore.appendToEvents({
        ...scope,
        events: [
          {
            type: EventType.MODEL_MESSAGE,
            id: MODEL_EVENT_ID,
            thread_id: 'main',
            created_at: new Date().toISOString(),
            content: null,
            tool_calls: [
              {
                id: input.held === 'approval' ? APPROVAL_CALL_ID : QUESTION_CALL_ID,
                type: 'function',
                function:
                  input.held === 'approval'
                    ? { name: 'restart_service', arguments: '{"service":"api"}' }
                    : {
                        name: ASK_USER_QUESTION_TOOL,
                        arguments: JSON.stringify({ question: 'Which one?', options: ['staging', 'production'] }),
                      },
                tool_info: { type: 'truefoundry-system', name: 'held' },
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
            type: input.held === 'approval' ? EventType.TOOL_APPROVAL_REQUIRED : EventType.TOOL_RESPONSE_REQUIRED,
            id: `evt-${input.held}`,
            created_at: new Date().toISOString(),
            thread_id: 'main',
            tool_calls: [
              {
                id: input.held === 'approval' ? APPROVAL_CALL_ID : QUESTION_CALL_ID,
                source_event_id: MODEL_EVENT_ID,
              },
            ],
          },
        ],
        completed_at: new Date().toISOString(),
      };
      await sessionStore.updateTurnState({ ...scope, state, turn_done_event: makeTurnDoneEvent(state) });
    },
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
    const delivery = await harness.integrationStore.getPendingDelivery({
      turn_id: routed.turn_id,
      conversation_key: inboundEvent().conversation_key,
    });
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
    expect(
      await harness.integrationStore.getPendingDelivery({
        turn_id: routed.turn_id,
        conversation_key: inboundEvent().conversation_key,
      }),
    ).toBeDefined();
    await harness.flush();
  });
});

describe('IntegrationRouter.resume', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  /** Starts a turn for the conversation, then leaves it held on `held`. */
  async function heldTurn(input: { held: 'approval' | 'question' }): Promise<{ turn_id: string }> {
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (routed.type !== 'started') {
      throw new Error('expected the turn to start');
    }
    await harness.holdTurn({ turn_id: routed.turn_id, held: input.held });
    await harness.flush();
    return { turn_id: routed.turn_id };
  }

  it('turns an approval click into a tool approval on the held call', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'approval' });

    const resumed = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id }),
    });

    expect(resumed).toMatchObject({ type: 'resumed', summary: 'Approved by <@U0ADMIN>.' });
    expect(harness.executor.starts[1]?.input).toEqual([
      {
        type: 'user.tool_approval',
        thread_id: 'main',
        tool_call_id: APPROVAL_CALL_ID,
        approval: { status: 'allow' },
      },
    ]);
  });

  it('records who denied it, because the reason is all the agent ever sees', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'approval' });

    const resumed = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id, decision: { type: 'approval', approved: false } }),
    });

    expect(resumed).toMatchObject({ type: 'resumed', summary: 'Denied by <@U0ADMIN>.' });
    expect(harness.executor.starts[1]?.input).toEqual([
      {
        type: 'user.tool_approval',
        thread_id: 'main',
        tool_call_id: APPROVAL_CALL_ID,
        approval: { status: 'deny', reason: 'Denied by Admin (U0ADMIN) from the channel.' },
      },
    ]);
  });

  it('turns an option click into the tool response the question is waiting for', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'question' });

    const resumed = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({
        turn_id,
        tool_call_id: QUESTION_CALL_ID,
        decision: { type: 'answer', text: 'production' },
      }),
    });

    expect(resumed).toMatchObject({ type: 'resumed', summary: '<@U0ADMIN> answered: production' });
    expect(harness.executor.starts[1]?.input).toEqual([
      {
        type: 'user.tool_response',
        thread_id: 'main',
        tool_call_id: QUESTION_CALL_ID,
        content: 'production',
      },
    ]);
  });

  it('a double click resumes once, because the second loses the turn’s own row', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'approval' });

    const first = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id }),
    });
    const second = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id }),
    });

    expect(first.type).toBe('resumed');
    expect(second).toEqual({ type: 'already_settled' });
    // One resume: two would fork the session and cancel the turn the first one started.
    expect(harness.executor.starts).toHaveLength(2);
  });

  it('a channel retry of one click is the same click, not a second one', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'approval' });
    const click = interaction({ turn_id });

    await harness.router.resume({ integration: harness.integration, interaction: click });
    const retry = await harness.router.resume({ integration: harness.integration, interaction: click });

    expect(retry).toEqual({ type: 'already_settled' });
  });

  it('refuses a click naming a turn this thread is no longer holding', async () => {
    harness = await createHarness();
    await heldTurn({ held: 'approval' });

    const resumed = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id: 'turn-that-never-existed' }),
    });

    expect(resumed).toMatchObject({ type: 'not_pending' });
    expect(harness.executor.starts).toHaveLength(1);
    // The claim is released, so a later real click on the same turn still works.
    expect(await harness.db.selectFrom('integration_event').selectAll().execute()).toHaveLength(1);
  });

  it('refuses a click naming a call the turn is not holding', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'approval' });

    const resumed = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id, tool_call_id: 'call-not-held' }),
    });

    expect(resumed).toMatchObject({ type: 'not_pending' });
    expect(harness.executor.starts).toHaveLength(1);
  });

  it('refuses an approval click on a turn that is only holding a question', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'question' });

    const resumed = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id, tool_call_id: QUESTION_CALL_ID }),
    });

    expect(resumed).toMatchObject({ type: 'not_pending' });
  });

  it('records the reply owed for the resumed turn', async () => {
    harness = await createHarness();
    const { turn_id } = await heldTurn({ held: 'approval' });

    const resumed = await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({ turn_id }),
    });
    if (resumed.type !== 'resumed') {
      throw new Error('expected the turn to resume');
    }
    await harness.flush();

    const rows = await harness.db.selectFrom('integration_delivery').selectAll().execute();
    expect(rows.map(row => row.turn_id)).toContain(resumed.turn_id);
  });
});

describe('a plain reply while the thread is held', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.db.destroy();
  });

  it('answers a pending question in free text', async () => {
    harness = await createHarness();
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (routed.type !== 'started') {
      throw new Error('expected the turn to start');
    }
    await harness.holdTurn({ turn_id: routed.turn_id, held: 'question' });
    await harness.flush();

    const answered = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent({ event_id: 'Ev0002', text: 'neither, use canary' }),
    });

    expect(answered.type).toBe('started');
    expect(harness.executor.starts[1]?.input).toEqual([
      {
        type: 'user.tool_response',
        thread_id: 'main',
        tool_call_id: QUESTION_CALL_ID,
        content: 'neither, use canary',
      },
    ]);
    expect(harness.channel.notices).toEqual([]);
  });

  it('gets the busy notice while an approval is pending, because that needs the buttons', async () => {
    harness = await createHarness();
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (routed.type !== 'started') {
      throw new Error('expected the turn to start');
    }
    await harness.holdTurn({ turn_id: routed.turn_id, held: 'approval' });
    await harness.flush();

    const replied = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent({ event_id: 'Ev0002', text: 'go ahead' }),
    });

    // A held approval is not running, so this is a fresh message, not a busy thread.
    expect(replied.type).toBe('started');
    expect(harness.executor.starts[1]?.input).toEqual([{ type: 'user.message', content: 'go ahead' }]);
  });

  it('loses to a button click that already claimed the turn', async () => {
    harness = await createHarness();
    const routed = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent(),
    });
    if (routed.type !== 'started') {
      throw new Error('expected the turn to start');
    }
    await harness.holdTurn({ turn_id: routed.turn_id, held: 'question' });
    await harness.flush();

    await harness.router.resume({
      integration: harness.integration,
      interaction: interaction({
        turn_id: routed.turn_id,
        tool_call_id: QUESTION_CALL_ID,
        decision: { type: 'answer', text: 'staging' },
      }),
    });
    const late = await harness.router.route({
      integration: harness.integration,
      adapter: harness.channel.adapter,
      event: inboundEvent({ event_id: 'Ev0003', text: 'actually production' }),
    });
    await harness.flush();

    expect(late).toMatchObject({ type: 'busy' });
    expect(harness.executor.starts).toHaveLength(2);
    expect(harness.channel.notices).toEqual([BUSY_CONVERSATION_NOTICE]);
  });
});
