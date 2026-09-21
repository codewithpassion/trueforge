/**
 * A Slack decision resumed through the **real** turn executor.
 *
 * Every other resume case drives a recording executor, which accepts whatever input it is
 * handed; core does not. It refuses a send that leaves any pending tool call unresolved, so
 * only a run against the real executor proves the batch this layer builds is one a turn takes —
 * and proves what happens when it is not.
 *
 * The held calls here are `ask_user_question`, because `require_approval_for_tools` is a
 * per-MCP-server selector and no MCP server is reachable from this pool. Core applies the same
 * rule to pending approvals and pending client-side calls, in the same check.
 */
import {
  AgentSpecSchema,
  Sessions,
  type CreatedBySubject,
  type SessionHandle,
} from '@truefoundry/trueforge-core/agent-session';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { McpServerWithAuthStore } from '../../src/db/McpServerWithAuthStore';
import { readPendingAction } from '../../src/integrations/pendingActions';
import { IntegrationRouter } from '../../src/integrations/router';
import { TurnCompletionNotifier } from '../../src/integrations/TurnCompletionNotifier';
import type { InboundInteraction } from '../../src/integrations/types';
import type { IntegrationManifest } from '../../src/schemas/integration';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersRuntimeDeps } from '../../src/workers/runtime';
import { fakeChannelAdapter } from '../unit/integrations/fakeChannelAdapter';
import { d1Persistence, migrateDatabase, sessionStub, TENANT_ID, upsertMockProvider, USER_REF } from './harness';

const CREATED_BY: CreatedBySubject = {
  subject_id: USER_REF,
  subject_type: 'user',
  subject_display_name: USER_REF,
};

const ANSWERER = 'U0ADMIN';

function manifest(agentName: string): IntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'trueforge',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    default_agent_name: agentName,
    allowed_channel_ids: ['C0GENERAL'],
    allow_direct_messages: true,
    reply_mode: 'thread',
    approver_slack_user_ids: [ANSWERER],
    notification_rules: [],
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
  };
}

type Stores = ReturnType<typeof d1Persistence>;

async function heldSession(input: { sessionId: string; scenario: string }) {
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: input.scenario });
  const conversationKey = `slack:T0TEAM:C0GENERAL:${input.sessionId}`;
  const integrationId = `int-${input.sessionId}`;
  const agentName = `support-${input.sessionId}`;
  const spec = AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' });
  await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: agentName,
    description: agentName,
    manifest: spec,
    external_id: null,
    created_by_subject: CREATED_BY,
  });
  await stores.integrationStore.createIntegration({
    id: integrationId,
    tenant_id: TENANT_ID,
    type: 'slack',
    external_account_id: `T-${input.sessionId}`,
    manifest: manifest(agentName),
    created_by_subject: CREATED_BY,
  });
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    created_by_subject: CREATED_BY,
    agent: { type: 'inline', spec },
    custom: null,
    metadata: {},
    external_id: conversationKey,
    source: { type: 'integration', id: integrationId, conversation_key: conversationKey },
  });
  return { stores, integrationId, conversationKey };
}

/** Runs a turn to its pause: the alarm holds it until the drain settles. */
async function runToPause(sessionId: string): Promise<string> {
  const stub = sessionStub(sessionId);
  const started = await stub.startTurn({
    tenant_id: TENANT_ID,
    session_id: sessionId,
    input: [{ type: 'user.message', content: 'ask me' }],
    previous_turn_id: undefined,
    user_ref: USER_REF,
  });
  if (!started.ok) {
    throw new Error(`startTurn failed: ${started.code} ${started.message}`);
  }
  await runInDurableObject(stub, instance => instance.alarm());
  return started.turn.id;
}

function workersRouter(stores: Stores) {
  const { turnExecutor } = createWorkersRuntimeDeps(env);
  const logger = createConsoleLogger({ level: 'error', bindings: {} });
  const channel = fakeChannelAdapter();
  const deferred: Promise<void>[] = [];
  const router = new IntegrationRouter({
    integrationStore: stores.integrationStore,
    sessions: new Sessions({ sessionStore: stores.sessionStore }),
    sessionStore: stores.sessionStore,
    agentStore: stores.agentStore,
    turnExecutor,
    resolveTurnStores: () => ({
      agentStore: stores.agentStore,
      modelProviderStore: stores.modelProviderStore,
      mcpServerStore: new McpServerWithAuthStore({
        store: stores.mcpServerStore,
        tokenStore: stores.tokenStore,
        clientName: 'trueforge-workers-tests',
      }),
      sandboxProviderStore: stores.sandboxProviderStore,
      skillStore: stores.skillStore,
    }),
    notifier: new TurnCompletionNotifier({
      integrationStore: stores.integrationStore,
      scheduleStore: stores.scheduleStore,
      adapters: channel.adapters,
      logger,
    }),
    deferDelivery: run => {
      deferred.push(run());
    },
    logger,
  });
  return {
    router,
    turnExecutor,
    flush: async (): Promise<void> => {
      await Promise.all(deferred.splice(0));
    },
  };
}

function answer(input: {
  turnId: string;
  toolCallId: string;
  conversationKey: string;
  integrationId: string;
}): InboundInteraction {
  return {
    integration_id: input.integrationId,
    conversation_key: input.conversationKey,
    sender: { id: ANSWERER, display_name: 'Admin' },
    turn_id: input.turnId,
    tool_call_id: input.toolCallId,
    decision: { type: 'answer', text: 'staging' },
    reply_context: 'https://hooks.slack.com/actions/T0TEAM/1/abc',
  };
}

async function sessionOf(stores: Stores, sessionId: string): Promise<SessionHandle> {
  const session = await new Sessions({ sessionStore: stores.sessionStore }).get({
    tenant_id: TENANT_ID,
    session_id: sessionId,
  });
  if (session === undefined) {
    throw new Error('session was not created');
  }
  return session;
}

async function heldTurnOf(stores: Stores, input: { sessionId: string; turnId: string }) {
  const turn = await (await sessionOf(stores, input.sessionId)).getTurn(input.turnId);
  if (turn === undefined || turn.state.status !== 'done') {
    throw new Error('expected the turn to pause');
  }
  return { turn, state: turn.state };
}

async function integrationOf(stores: Stores, id: string) {
  const integration = await stores.integrationStore.getIntegrationById({ id });
  if (integration === undefined) {
    throw new Error(`integration was not created: ${id}`);
  }
  return integration;
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('a Slack decision through the real turn executor', () => {
  it('resumes a turn held on one call, and core accepts the batch', async () => {
    const sessionId = 'resume-one-call';
    const { stores, integrationId, conversationKey } = await heldSession({ sessionId, scenario: 'ask-1' });
    const turnId = await runToPause(sessionId);
    const { turn, state } = await heldTurnOf(stores, { sessionId, turnId });

    const pending = await readPendingAction({ turn, state });
    if (pending?.type !== 'question') {
      throw new Error('expected the turn to hold one question');
    }

    const { router, flush } = workersRouter(stores);
    const resumed = await router.resume({
      integration: await integrationOf(stores, integrationId),
      interaction: answer({
        turnId,
        toolCallId: pending.question.tool_call_id,
        conversationKey,
        integrationId,
      }),
    });
    await flush();

    expect(resumed.type).toBe('resumed');
    if (resumed.type !== 'resumed') {
      throw new Error('expected the turn to resume');
    }
    await runInDurableObject(sessionStub(sessionId), instance => instance.alarm());
    const after = await (await sessionOf(stores, sessionId)).getTurn(resumed.turn_id);
    expect(after?.state.status).toBe('done');
    if (after?.state.status === 'done') {
      expect(after.state.required_actions).toEqual([]);
    }
  });

  // This is the failure B1 was about, asserted rather than described: a batch that settles one
  // of two held calls is refused by core before anything is persisted.
  it('is refused cleanly when the batch leaves a held call unresolved, and the held turn survives', async () => {
    const sessionId = 'resume-partial-batch';
    const { stores } = await heldSession({ sessionId, scenario: 'ask-2' });
    const turnId = await runToPause(sessionId);
    const { state } = await heldTurnOf(stores, { sessionId, turnId });

    const held = state.required_actions.flatMap(action =>
      action.type === 'tool.response_required' ? action.tool_calls.map(ref => ref.id) : [],
    );
    expect(held).toHaveLength(2);

    const { turnExecutor } = workersRouter(stores);
    const partial = await turnExecutor.start({
      session: await sessionOf(stores, sessionId),
      input: [{ type: 'user.tool_response', thread_id: 'main', tool_call_id: held[0] ?? '', content: 'staging' }],
      previous_turn_id: 'auto',
      userRef: USER_REF,
      stores: {
        agentStore: stores.agentStore,
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: new McpServerWithAuthStore({
          store: stores.mcpServerStore,
          tokenStore: stores.tokenStore,
          clientName: 'trueforge-workers-tests',
        }),
        sandboxProviderStore: stores.sandboxProviderStore,
        skillStore: stores.skillStore,
      },
    });

    expect(partial.ok).toBe(false);
    if (partial.ok) {
      throw new Error('expected core to refuse the partial batch');
    }
    expect(partial.code).toBe('invalid_send_input');
    expect(partial.message).toContain('resolve all pending tool calls');
    // Nothing was persisted, so the turn is still there to decide on.
    const stillHeld = await (await sessionOf(stores, sessionId)).getTurn(turnId);
    expect(stillHeld?.state.status).toBe('done');
  });

  it('offers no buttons for a set one interaction cannot settle', async () => {
    const sessionId = 'resume-two-calls';
    const { stores, integrationId, conversationKey } = await heldSession({ sessionId, scenario: 'ask-2' });
    const turnId = await runToPause(sessionId);
    const { turn, state } = await heldTurnOf(stores, { sessionId, turnId });

    // Two held calls: one answer would leave the other unresolved, so nothing is offered.
    expect(await readPendingAction({ turn, state })).toBeUndefined();

    const { router, flush } = workersRouter(stores);
    const resumed = await router.resume({
      integration: await integrationOf(stores, integrationId),
      interaction: answer({ turnId, toolCallId: 'call_1', conversationKey, integrationId }),
    });
    await flush();

    expect(resumed).toMatchObject({ type: 'not_pending' });
    const stillHeld = await (await sessionOf(stores, sessionId)).getTurn(turnId);
    expect(stillHeld?.state.status).toBe('done');
  });
});
