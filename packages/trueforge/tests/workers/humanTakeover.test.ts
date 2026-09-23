/**
 * A desktop takeover end to end on Workers: the model asks through the real session Durable
 * Object, its drain records a pointer on the real relay, and the hand-back resumes the session
 * through the real executor while the creator may be answering the same call in chat.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, EventType, Sessions, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createTurnsRouter } from '../../src/apis/turns';
import { createAppErrorHandler } from '../../src/app';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import type { RequestContext } from '../../src/auth/identity';
import type { ComputerCapabilities } from '../../src/computers/protocol';
import { createHumanTakeoverService, type HumanTakeoverService } from '../../src/computers/takeover';
import { newId } from '../../src/utils/id';
import { workersComputersService } from '../../src/workers/computersService';
import { createConsoleLogger } from '../../src/workers/logger';
import { WorkersTurnExecutor } from '../../src/workers/workersTurnExecutor';
import { d1Persistence, migrateDatabase, sessionStub, TENANT_ID, upsertMockProvider, USER_REF } from './harness';
import { connectNewComputer } from './remoteComputerClient';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'takeover-test' } });
const HELPER = 'u-helper';
const REASON = 'Log into the supplier portal';
const WITH_DESKTOP: ComputerCapabilities = {
  python3: true,
  git: true,
  skills: false,
  desktop: true,
  desktop_unavailable_reason: null,
};
const CALLER: RequestContext = {
  tenant_id: TENANT_ID,
  subject: { id: USER_REF, type: 'user', display_name: USER_REF },
  roles: [],
  user_credential: null,
};

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

function executor(): WorkersTurnExecutor {
  return new WorkersTurnExecutor({ namespace: env.SESSION_DO, sessionStore: d1Persistence().sessionStore });
}

function takeovers(): HumanTakeoverService {
  const stores = d1Persistence();
  return createHumanTakeoverService({
    computers: workersComputersService(env),
    sessions: new Sessions({ sessionStore: stores.sessionStore }),
    agentStore: stores.agentStore,
    turnExecutor: executor(),
    resolveTurnStores: () => ({
      agentStore: stores.agentStore,
      modelProviderStore: stores.modelProviderStore,
      mcpServerStore: stores.mcpServerStore,
      sandboxProviderStore: stores.sandboxProviderStore,
      skillStore: stores.skillStore,
    }),
    logger,
  });
}

/** The turns routes over D1 and the Workers executor, as the chat reaches them. */
function turnsApp() {
  const stores = d1Persistence();
  const app = new OpenAPIHono();
  app.onError(createAppErrorHandler({ logger }));
  app.route(
    '/',
    createTurnsRouter({
      sessions: new Sessions({ sessionStore: stores.sessionStore }),
      sessionStore: stores.sessionStore,
      resolveModelProviderStore: () => stores.modelProviderStore,
      resolveMcpServerStore: () => stores.mcpServerStore,
      resolveSkillStore: () => stores.skillStore,
      resolveAgentStore: () => stores.agentStore,
      turnExecutor: executor(),
      resolveSandboxProviderStore: () => stores.sandboxProviderStore,
      sandboxIntegration: undefined,
      logger,
      resolveRequestContext: () => CALLER,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );
  return app;
}

/** The creator answering the pending call in chat, the way the web client sends it. */
async function chatAnswer(input: {
  sessionId: string;
  toolCallId: string;
  previousTurnId?: string;
}): Promise<{ status: number; code: string | null | undefined }> {
  const turnInput: TurnInputItem[] = [
    { type: EventType.USER_TOOL_RESPONSE, thread_id: 'main', tool_call_id: input.toolCallId, content: 'done in chat' },
  ];
  const response = await turnsApp().request(`/${input.sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: turnInput,
      stream: false,
      ...(input.previousTurnId === undefined ? {} : { previous_turn_id: input.previousTurnId }),
    }),
  });
  if (response.status === 200) {
    return { status: 200, code: undefined };
  }
  const body = await response.json<{ error: { code?: string | null } }>();
  return { status: response.status, code: body.error.code };
}

/** A computer with a desktop, and an agent on it that asks for a takeover on its first turn. */
async function desktopAgent() {
  const { computerId, client } = await connectNewComputer({
    name: unique('takeover-box'),
    options: { hello: { capabilities: WITH_DESKTOP }, onRequest: () => ({ ok: true }) },
  });
  const stores = d1Persistence();
  const computers = workersComputersService(env);
  const providerName = await upsertMockProvider({ stores, scenario: 'takeover' });
  const agent = await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: unique('takeover-agent'),
    description: 'asks for a person',
    manifest: AgentSpecSchema.parse({
      model: { name: `${providerName}/mock-model` },
      instructions: 'test',
      config: { sandbox: { enabled: true, file_downloads: false, computer_id: computerId, desktop: true } },
    }),
    external_id: null,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
  });
  await computers.store.putAgentAccess({
    tenant_id: TENANT_ID,
    computer_id: computerId,
    agents: [{ agent_id: agent.id, agent_name: agent.name }],
  });
  await computers.store.updateComputer({
    tenant_id: TENANT_ID,
    computer_id: computerId,
    name: undefined,
    require_approval: false,
  });
  return { computerId, client, agentId: agent.id, agentName: agent.name };
}

/** A session of the agent run to its takeover request; the alarm holds the turn until it drains. */
async function waitingSession(agent: { agentId: string; agentName: string; computerId: string }) {
  const stores = d1Persistence();
  const sessionId = `takeover-${newId()}`;
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: sessionId,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
    agent: { type: 'reference', id: agent.agentId, name: agent.agentName },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  const turnId = await runTurn({
    sessionId,
    input: [{ type: 'user.message', content: 'get the invoices' }],
  });
  // The pointer is written by the drain hook, after the turn's own state flip.
  const relay = workersComputersService(env).relay(agent.computerId);
  await until(async () =>
    (await relay.listTakeoverPointers({ tenant_id: TENANT_ID })).some(pointer => pointer.session_id === sessionId),
  );
  return { sessionId, turnId };
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('condition never became true');
}

async function runTurn(input: { sessionId: string; input: TurnInputItem[] }): Promise<string> {
  const stub = sessionStub(input.sessionId);
  const started = await stub.startTurn({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    input: input.input,
    previous_turn_id: undefined,
    user_ref: USER_REF,
  });
  if (!started.ok) {
    throw new Error(`startTurn failed: ${started.code} ${started.message}`);
  }
  await drain(input.sessionId);
  return started.turn.id;
}

/** Holds the session's turns until none runs. A platform-run alarm may already be holding them. */
async function drain(sessionId: string): Promise<void> {
  await runInDurableObject(sessionStub(sessionId), instance => instance.alarm());
  await until(async () => (await turnsOf(sessionId)).every(turn => turn.state.status !== 'running'));
}

async function turnsOf(sessionId: string) {
  const { data } = await d1Persistence().sessionStore.listTurns({
    session_id: sessionId,
    limit: 20,
    page_token: undefined,
  });
  return data;
}

function resolve(service: HumanTakeoverService, input: { computerId: string; sessionId: string }) {
  return service.resolveTakeover({
    tenant_id: TENANT_ID,
    computer_id: input.computerId,
    session_id: input.sessionId,
    outcome: 'completed',
    note: 'logged in',
    acting_user_id: HELPER,
  });
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('a desktop takeover', () => {
  it('records a pointer when the turn ends asking, and lists it with the reason from the turn', async () => {
    const agent = await desktopAgent();
    const { sessionId, turnId } = await waitingSession(agent);

    const turn = await d1Persistence().sessionStore.getTurn({ session_id: sessionId, turn_id: turnId });
    expect(turn?.state.status).toBe('done');
    expect(
      await workersComputersService(env).relay(agent.computerId).listTakeoverPointers({ tenant_id: TENANT_ID }),
    ).toEqual([{ session_id: sessionId, turn_id: turnId }]);
    const pending = await takeovers().listPendingTakeovers({ tenant_id: TENANT_ID, computer_id: agent.computerId });
    expect(pending).toEqual([
      {
        session_id: sessionId,
        turn_id: turnId,
        tool_call_id: 'call_1',
        reason: REASON,
        requested_at: turn?.state.status === 'done' ? turn.state.completed_at : '',
        agent_id: agent.agentId,
      },
    ]);
    expect(
      await takeovers().listPendingTakeovers({
        tenant_id: TENANT_ID,
        computer_id: agent.computerId,
        agent_id: 'other',
      }),
    ).toEqual([]);
    agent.client.close();
  });

  it('keeps two waiting sessions apart: resolving one leaves the other pending', async () => {
    const agent = await desktopAgent();
    const first = await waitingSession(agent);
    const second = await waitingSession(agent);
    const service = takeovers();

    const listed = await service.listPendingTakeovers({ tenant_id: TENANT_ID, computer_id: agent.computerId });
    expect(listed.map(entry => entry.session_id).sort()).toEqual([first.sessionId, second.sessionId].sort());

    expect(await resolve(service, { computerId: agent.computerId, sessionId: first.sessionId })).toEqual({ ok: true });
    const left = await service.listPendingTakeovers({ tenant_id: TENANT_ID, computer_id: agent.computerId });
    expect(left.map(entry => entry.session_id)).toEqual([second.sessionId]);
    await drain(first.sessionId);
    agent.client.close();
  });

  it('resumes the session exactly once with the tool response, and audits who handed back', async () => {
    const agent = await desktopAgent();
    const { sessionId, turnId } = await waitingSession(agent);
    const service = takeovers();

    expect(await resolve(service, { computerId: agent.computerId, sessionId })).toEqual({ ok: true });
    expect(await resolve(service, { computerId: agent.computerId, sessionId })).toEqual({
      ok: false,
      code: 'not_pending',
    });
    await drain(sessionId);

    const turns = await turnsOf(sessionId);
    expect(turns).toHaveLength(2);
    const resumed = turns.find(turn => turn.turn_id !== turnId);
    expect(resumed?.previous_turn_id).toBe(turnId);
    expect(resumed?.input).toEqual([
      {
        type: EventType.USER_TOOL_RESPONSE,
        thread_id: 'main',
        tool_call_id: 'call_1',
        content: JSON.stringify({ outcome: 'completed', note: 'logged in' }),
      },
    ]);
    expect(resumed?.state.status).toBe('done');
    const audit = await workersComputersService(env).store.listAudit({
      tenant_id: TENANT_ID,
      computer_id: agent.computerId,
      limit: 10,
      before_id: undefined,
    });
    expect(audit.map(row => row.command)).toContain(`computer.desktop.hand_back by ${HELPER}`);
    agent.client.close();
  });

  it('refuses the chat answer with 409 once the hand-back resumed the session', async () => {
    const agent = await desktopAgent();
    const { sessionId } = await waitingSession(agent);

    expect(await resolve(takeovers(), { computerId: agent.computerId, sessionId })).toEqual({ ok: true });
    expect(await chatAnswer({ sessionId, toolCallId: 'call_1' })).toEqual({ status: 409, code: 'already_answered' });
    await drain(sessionId);
    expect(await turnsOf(sessionId)).toHaveLength(2);
    agent.client.close();
  });

  it('answers the hand-back takeover_already_answered once the chat answered, and drops the stale pointer', async () => {
    const agent = await desktopAgent();
    const { sessionId } = await waitingSession(agent);

    expect(await chatAnswer({ sessionId, toolCallId: 'call_1' })).toEqual({ status: 200, code: undefined });
    await drain(sessionId);
    expect(await resolve(takeovers(), { computerId: agent.computerId, sessionId })).toEqual({
      ok: false,
      code: 'takeover_already_answered',
    });
    expect(await takeovers().listPendingTakeovers({ tenant_id: TENANT_ID, computer_id: agent.computerId })).toEqual([]);
    expect(
      await workersComputersService(env).relay(agent.computerId).listTakeoverPointers({ tenant_id: TENANT_ID }),
    ).toEqual([]);
    expect(await turnsOf(sessionId)).toHaveLength(2);
    agent.client.close();
  });

  it('lets a hand-back and a chat answer race: one resumes, the other is refused, and the session never forks', async () => {
    const agent = await desktopAgent();
    const { sessionId } = await waitingSession(agent);

    const [handedBack, answered] = await Promise.all([
      resolve(takeovers(), { computerId: agent.computerId, sessionId }),
      chatAnswer({ sessionId, toolCallId: 'call_1' }),
    ]);
    await drain(sessionId);

    const handBackWon = handedBack.ok;
    const chatWon = answered.status === 200;
    expect([handBackWon, chatWon].filter(Boolean)).toHaveLength(1);
    if (handBackWon) {
      expect(answered).toEqual({ status: 409, code: 'already_answered' });
    } else {
      expect(handedBack).toEqual({ ok: false, code: 'takeover_already_answered' });
    }
    expect(await turnsOf(sessionId)).toHaveLength(2);
    agent.client.close();
  });

  it('still accepts an explicit previous_turn_id, which forks on purpose', async () => {
    const agent = await desktopAgent();
    const { sessionId, turnId } = await waitingSession(agent);

    expect(await resolve(takeovers(), { computerId: agent.computerId, sessionId })).toEqual({ ok: true });
    await drain(sessionId);
    expect(await chatAnswer({ sessionId, toolCallId: 'call_1', previousTurnId: turnId })).toEqual({
      status: 200,
      code: undefined,
    });
    await drain(sessionId);

    const turns = await turnsOf(sessionId);
    expect(turns).toHaveLength(3);
    expect(turns.filter(turn => turn.previous_turn_id === turnId)).toHaveLength(2);
    agent.client.close();
  });
});

describe('takeover pointers on the relay', () => {
  it('are kept per session, cleared only for the turn they name, and hidden from another tenant', async () => {
    const { computerId, client } = await connectNewComputer({
      name: unique('pointer-box'),
      options: { hello: { capabilities: WITH_DESKTOP }, onRequest: () => ({ ok: true }) },
    });
    const relay = workersComputersService(env).relay(computerId);

    expect(await relay.recordTakeoverPointer({ tenant_id: TENANT_ID, session_id: 's-a', turn_id: 't-1' })).toEqual({
      recorded: true,
    });
    expect(await relay.recordTakeoverPointer({ tenant_id: TENANT_ID, session_id: 's-b', turn_id: 't-2' })).toEqual({
      recorded: true,
    });
    // A later request from the same session replaces its pointer.
    await relay.recordTakeoverPointer({ tenant_id: TENANT_ID, session_id: 's-a', turn_id: 't-3' });
    expect(await relay.listTakeoverPointers({ tenant_id: TENANT_ID })).toEqual([
      { session_id: 's-b', turn_id: 't-2' },
      { session_id: 's-a', turn_id: 't-3' },
    ]);

    expect(await relay.clearTakeoverPointer({ tenant_id: TENANT_ID, session_id: 's-a', turn_id: 't-1' })).toEqual({
      cleared: false,
    });
    expect(await relay.listTakeoverPointers({ tenant_id: 'another-tenant' })).toEqual([]);
    expect(
      await relay.recordTakeoverPointer({ tenant_id: 'another-tenant', session_id: 's-x', turn_id: 't-x' }),
    ).toEqual({ recorded: false });
    expect(
      await relay.clearTakeoverPointer({ tenant_id: 'another-tenant', session_id: 's-b', turn_id: 't-2' }),
    ).toEqual({ cleared: false });

    expect(await relay.clearTakeoverPointer({ tenant_id: TENANT_ID, session_id: 's-a', turn_id: 't-3' })).toEqual({
      cleared: true,
    });
    expect(await relay.listTakeoverPointers({ tenant_id: TENANT_ID })).toEqual([{ session_id: 's-b', turn_id: 't-2' }]);
    client.close();
  });
});
