/**
 * The desktop lease over a real relay Durable Object and a fake machine: who may drive the desktop,
 * who is refused and with what, and that a turn gives the lease back when it ends.
 */
import { AgentSpecSchema, Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  ClientOpRequestSchema,
  type ComputerCapabilities,
  type RelayPrincipal,
  type RequestOutcome,
} from '../../src/computers/protocol';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { validateAgentSpec } from '../../src/runtime/sessionResources';
import { createTurnDrainedHook } from '../../src/runtime/turnDrainedHook';
import { startTurnInProcess } from '../../src/runtime/turnRunner';
import { newId } from '../../src/utils/id';
import { workersComputersService } from '../../src/workers/computersService';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersSandboxIntegration } from '../../src/workers/sandbox/workersSandboxIntegration';
import { d1Persistence, migrateDatabase, sessionStub, TENANT_ID, upsertMockProvider, USER_REF } from './harness';
import { connectNewComputer, settle, type FakeComputerClient } from './remoteComputerClient';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'desktop-test' } });

const OK_EXEC = { exit_code: 0, stdout: '', stderr: '', bytes_total: 0, truncated: false, duration_ms: 1 };
const SCREENSHOT = { data_b64: '/9j/4AAQ', width: 1280, height: 800, media_type: 'image/jpeg' };
const WITH_DESKTOP: ComputerCapabilities = {
  python3: true,
  git: true,
  skills: false,
  desktop: true,
  desktop_unavailable_reason: null,
};
const WITHOUT_DESKTOP: ComputerCapabilities = {
  ...WITH_DESKTOP,
  desktop: false,
  desktop_unavailable_reason: 'Xvfb did not start',
};

function answer(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  switch (frame['op']) {
    case 'exec':
      return OK_EXEC;
    case 'desktop_screenshot':
      return SCREENSHOT;
    case 'desktop_clipboard_get':
      return { text: 'copied' };
    case 'desktop_input':
    case 'desktop_clipboard_set':
      return { ok: true };
    default:
      return undefined;
  }
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

async function desktopComputer(capabilities: ComputerCapabilities = WITH_DESKTOP) {
  return connectNewComputer({ name: unique('desktop-box'), options: { hello: { capabilities }, onRequest: answer } });
}

function agent(sessionId: string): RelayPrincipal {
  return { kind: 'agent', session_id: sessionId };
}

function human(userId: string): RelayPrincipal {
  return { kind: 'human', user_id: userId };
}

const OPS = {
  screenshot: { op: 'desktop_screenshot', quality: null },
  input: { op: 'desktop_input', actions: [{ type: 'click', x: 10, y: 20, button: 'left', count: 1 }] },
  clipboardGet: { op: 'desktop_clipboard_get' },
  exec: { op: 'exec', command: 'true', cwd: null, env: {}, timeout_ms: 1000 },
} as const;

function send({
  computerId,
  principal,
  op,
}: {
  computerId: string;
  principal: RelayPrincipal;
  op: Record<string, unknown>;
}): Promise<RequestOutcome> {
  return workersComputersService(env)
    .relay(computerId)
    .request({ tenant_id: TENANT_ID, op_json: JSON.stringify(op), timeout_ms: 2000, principal });
}

function relayStub(computerId: string) {
  return env.REMOTE_COMPUTER_DO.get(env.REMOTE_COMPUTER_DO.idFromName(computerId));
}

function refusedWith(outcome: RequestOutcome): string | undefined {
  return outcome.ok ? undefined : outcome.reason;
}

function desktopFrames(client: FakeComputerClient) {
  return client.received.filter(frame => String(frame['op']).startsWith('desktop_'));
}

beforeAll(async () => {
  await migrateDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the desktop relay', () => {
  it('never sends a desktop op to a machine without a desktop', async () => {
    const { computerId, client } = await desktopComputer(WITHOUT_DESKTOP);

    const outcome = await send({ computerId, principal: agent('s-1'), op: OPS.screenshot });
    expect(refusedWith(outcome)).toBe('desktop_unavailable');
    expect(outcome.ok ? '' : outcome.message).toContain('Xvfb did not start');
    await expect(relayStub(computerId).takeHumanLease({ user_id: 'u-1' })).resolves.toMatchObject({
      ok: false,
      reason: 'desktop_unavailable',
    });
    // Commands still run: only the desktop is missing.
    expect((await send({ computerId, principal: agent('s-1'), op: OPS.exec })).ok).toBe(true);
    expect(desktopFrames(client)).toHaveLength(0);
    client.close();
  });

  it('sends desktop ops the client can parse, on the contract', async () => {
    const { computerId, client } = await desktopComputer();
    for (const op of [OPS.screenshot, OPS.input, OPS.clipboardGet]) {
      expect((await send({ computerId, principal: agent('s-1'), op })).ok).toBe(true);
    }
    const frames = desktopFrames(client);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(ClientOpRequestSchema.safeParse(frame).success).toBe(true);
    }
    client.close();
  });

  it('gives a second session desktop_busy until the first releases, and leaves its commands alone', async () => {
    const { computerId, client } = await desktopComputer();

    expect((await send({ computerId, principal: agent('s-a'), op: OPS.screenshot })).ok).toBe(true);
    expect(refusedWith(await send({ computerId, principal: agent('s-b'), op: OPS.screenshot }))).toBe('desktop_busy');
    expect(refusedWith(await send({ computerId, principal: agent('s-b'), op: OPS.input }))).toBe('desktop_busy');
    // `exec` never needs the agent lease.
    expect((await send({ computerId, principal: agent('s-b'), op: OPS.exec })).ok).toBe(true);
    // The holder keeps working.
    expect((await send({ computerId, principal: agent('s-a'), op: OPS.input })).ok).toBe(true);

    // Only the holder can let go.
    await expect(relayStub(computerId).releaseLease({ session_id: 's-b' })).resolves.toEqual({ released: false });
    await expect(relayStub(computerId).releaseLease({ session_id: 's-a' })).resolves.toEqual({ released: true });
    expect((await send({ computerId, principal: agent('s-b'), op: OPS.screenshot })).ok).toBe(true);
    client.close();
  });

  it('lets a person preempt an agent, and refuses agent screenshots and commands while they hold it', async () => {
    const { computerId, client } = await desktopComputer();
    expect((await send({ computerId, principal: agent('s-a'), op: OPS.screenshot })).ok).toBe(true);

    await expect(relayStub(computerId).takeHumanLease({ user_id: 'u-1' })).resolves.toEqual({ ok: true });
    const framesAtTakeover = client.received.length;

    // The agent that held it, and every other agent, now sees nothing and runs nothing.
    for (const session of ['s-a', 's-b']) {
      for (const op of [OPS.screenshot, OPS.input, OPS.clipboardGet, OPS.exec]) {
        expect(refusedWith(await send({ computerId, principal: agent(session), op }))).toBe('human_in_control');
      }
    }
    expect(client.received.length).toBe(framesAtTakeover);

    // The person in control drives it.
    for (const op of [OPS.screenshot, OPS.input, OPS.clipboardGet]) {
      expect((await send({ computerId, principal: human('u-1'), op })).ok).toBe(true);
    }
    // Another person neither sees nor drives it.
    expect(refusedWith(await send({ computerId, principal: human('u-2'), op: OPS.screenshot }))).toBe(
      'human_in_control',
    );
    expect(refusedWith(await send({ computerId, principal: human('u-2'), op: OPS.input }))).toBe('human_in_control');
    // A lease release from the agent's turn does not end the person's control.
    await expect(relayStub(computerId).releaseLease({ session_id: 's-a' })).resolves.toEqual({ released: false });
    client.close();
  });

  it('lets anyone watch while nobody holds control, but only the controller type or read the clipboard', async () => {
    const { computerId, client } = await desktopComputer();
    expect((await send({ computerId, principal: human('u-1'), op: OPS.screenshot })).ok).toBe(true);
    expect(refusedWith(await send({ computerId, principal: human('u-1'), op: OPS.input }))).toBe('forbidden');
    expect(refusedWith(await send({ computerId, principal: human('u-1'), op: OPS.clipboardGet }))).toBe('forbidden');
    // Watching takes no lease, so an agent can still start.
    expect((await send({ computerId, principal: agent('s-a'), op: OPS.input })).ok).toBe(true);
    // A person may watch an agent at work.
    expect((await send({ computerId, principal: human('u-1'), op: OPS.screenshot })).ok).toBe(true);
    // A person sends desktop ops only.
    expect(refusedWith(await send({ computerId, principal: human('u-1'), op: OPS.exec }))).toBe('forbidden');
    client.close();
  });

  it('clears both clipboard selections when a person hands back, then frees the desktop', async () => {
    const { computerId, client } = await desktopComputer();
    await relayStub(computerId).takeHumanLease({ user_id: 'u-1' });

    await expect(relayStub(computerId).releaseHumanLease({ user_id: 'u-2' })).resolves.toEqual({
      released: false,
      clipboard_cleared: false,
    });
    await expect(relayStub(computerId).releaseHumanLease({ user_id: 'u-1' })).resolves.toEqual({
      released: true,
      clipboard_cleared: true,
    });

    const clears = client.received.filter(frame => frame['op'] === 'desktop_clipboard_set');
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ text: '', selections: ['clipboard', 'primary'] });
    expect((await send({ computerId, principal: agent('s-a'), op: OPS.screenshot })).ok).toBe(true);
    client.close();
  });

  it('expires an idle agent lease after ten minutes, and an idle person after five with the clipboard cleared', async () => {
    const { computerId, client } = await desktopComputer();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);

    expect((await send({ computerId, principal: agent('s-a'), op: OPS.screenshot })).ok).toBe(true);
    offset = 9 * 60_000;
    expect(refusedWith(await send({ computerId, principal: agent('s-b'), op: OPS.screenshot }))).toBe('desktop_busy');
    offset = 11 * 60_000;
    expect((await send({ computerId, principal: agent('s-b'), op: OPS.screenshot })).ok).toBe(true);

    offset = 0;
    await relayStub(computerId).takeHumanLease({ user_id: 'u-1' });
    // Only the alarm's lease check sees the future: its heartbeat check must still see a live socket.
    clock.mockImplementationOnce(() => realNow() + 6 * 60_000);
    // The relay's own alarm ends a person's control even when nobody else asks for the desktop.
    await runInDurableObject(relayStub(computerId), instance => instance.alarm());
    await settle();
    expect(client.received.filter(frame => frame['op'] === 'desktop_clipboard_set')).toHaveLength(1);
    expect((await send({ computerId, principal: agent('s-a'), op: OPS.screenshot })).ok).toBe(true);
    client.close();
  });
});

function computerIntegration() {
  return createWorkersSandboxIntegration({
    backend: undefined,
    computers: workersComputersService(env),
    namespace: env.COMPUTER_DO,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 1024 * 1024,
    codeModeRegistry: undefined,
  });
}

async function desktopAgentSession({
  computerId,
  requireApproval = false,
}: {
  computerId: string;
  requireApproval?: boolean;
}) {
  const stores = d1Persistence();
  const computers = workersComputersService(env);
  const providerName = await upsertMockProvider({ stores, scenario: 'desktop' });
  const created = await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: unique('desktop-agent'),
    description: 'uses the desktop',
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
    agents: [{ agent_id: created.id, agent_name: created.name }],
  });
  await computers.store.updateComputer({
    tenant_id: TENANT_ID,
    computer_id: computerId,
    name: undefined,
    require_approval: requireApproval,
  });
  const sessionId = `desktop-${newId()}`;
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: sessionId,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
    agent: { type: 'reference', id: created.id, name: created.name },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  return { stores, sessionId, agentId: created.id, providerName };
}

/** A turn run in-process with whichever drained hook the case wants, or none. */
async function runDesktopTurn({
  stores,
  sessionId,
  withHook,
}: {
  stores: ReturnType<typeof d1Persistence>;
  sessionId: string;
  withHook: boolean;
}) {
  const session = await new Sessions({ sessionStore: stores.sessionStore }).get({
    tenant_id: TENANT_ID,
    session_id: sessionId,
  });
  if (session === undefined) {
    throw new Error('expected the session that was just created');
  }
  const computers = workersComputersService(env);
  const started = await startTurnInProcess({
    session,
    turn_id: newId(),
    input: [{ type: 'user.message', content: 'look at the screen' }],
    previous_turn_id: undefined,
    active_executor_id: 'test',
    userRef: USER_REF,
    request_metadata: undefined,
    deps: {
      agentStore: stores.agentStore,
      modelProviderStore: stores.modelProviderStore,
      mcpServerStore: stores.mcpServerStore,
      sandboxProviderStore: stores.sandboxProviderStore,
      skillStore: stores.skillStore,
      activeTurns: new ActiveTurnRegistry(),
      eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
      logger,
      sandboxIntegration: computerIntegration(),
      onTurnDrained: withHook
        ? createTurnDrainedHook({ deliver: () => Promise.resolve(), computers, logger })
        : undefined,
    },
  });
  await started.drained;
  return stores.sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.record.turn_id });
}

describe('a desktop turn', () => {
  it('takes the lease with its first screenshot and keeps it when nothing releases it', async () => {
    const { computerId, client } = await desktopComputer();
    const { stores, sessionId } = await desktopAgentSession({ computerId });

    const finished = await runDesktopTurn({ stores, sessionId, withHook: false });

    expect(finished?.state.status).toBe('done');
    expect(client.received.some(frame => frame['op'] === 'desktop_screenshot')).toBe(true);
    // Images do not reach the model yet; the stub says what was captured.
    expect(JSON.stringify(finished?.snapshot.threads ?? {})).toContain('[screenshot 1280x800 captured');
    // A screenshot-only session still records its sandbox, which is how the turn end finds the machine.
    expect(finished?.snapshot.sandbox_info?.sandbox_id).toBe(`v1:remote-computer:${computerId}/${sessionId}`);
    expect(refusedWith(await send({ computerId, principal: agent('someone-else'), op: OPS.screenshot }))).toBe(
      'desktop_busy',
    );
    client.close();
  });

  it('releases the lease when the turn drains', async () => {
    const { computerId, client } = await desktopComputer();
    const { stores, sessionId } = await desktopAgentSession({ computerId });

    const finished = await runDesktopTurn({ stores, sessionId, withHook: true });

    expect(finished?.state.status).toBe('done');
    expect(client.received.some(frame => frame['op'] === 'desktop_screenshot')).toBe(true);
    expect((await send({ computerId, principal: agent('someone-else'), op: OPS.screenshot })).ok).toBe(true);
    client.close();
  });

  it('releases the lease at turn end inside the session Durable Object', async () => {
    const { computerId, client } = await desktopComputer();
    const { sessionId } = await desktopAgentSession({ computerId });
    const stub = sessionStub(sessionId);

    const started = await stub.startTurn({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      input: [{ type: 'user.message', content: 'look at the screen' }],
      previous_turn_id: undefined,
      user_ref: USER_REF,
    });
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }
    // The platform's own alarm may already hold the turn, so wait for what the drained hook leaves behind.
    const readLease = () =>
      runInDurableObject(relayStub(computerId), (_instance, state) => state.storage.get('desktop_lease'));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const turn = await d1Persistence().sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.id });
      if (turn?.state.status !== 'running' && (await readLease()) === undefined) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const finished = await d1Persistence().sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.id });
    expect(finished?.state.status).toBe('done');
    expect(client.received.some(frame => frame['op'] === 'desktop_screenshot')).toBe(true);
    expect(await readLease()).toBeUndefined();
    expect((await send({ computerId, principal: agent('someone-else'), op: OPS.screenshot })).ok).toBe(true);
    client.close();
  });
});

describe('a desktop agent spec', () => {
  async function validate({
    grantedOn,
    computerId,
    desktop,
  }: {
    grantedOn: string;
    computerId: string | undefined;
    desktop: boolean;
  }) {
    const { stores, agentId, providerName } = await desktopAgentSession({ computerId: grantedOn });
    return validateAgentSpec({
      spec: AgentSpecSchema.parse({
        model: { name: `${providerName}/mock-model` },
        config: {
          sandbox: { enabled: true, ...(computerId === undefined ? {} : { computer_id: computerId }), desktop },
        },
      }),
      tenant_id: TENANT_ID,
      agent_id: agentId,
      modelProviderStore: stores.modelProviderStore,
      mcpServerStore: stores.mcpServerStore,
      skillStore: stores.skillStore,
      sandboxProviderStore: stores.sandboxProviderStore,
      sandboxIntegration: computerIntegration(),
      logger,
    });
  }

  it('is refused on a computer that reported no desktop, and accepted on one that did', async () => {
    const without = await desktopComputer(WITHOUT_DESKTOP);
    const withDesktop = await desktopComputer();
    const on = (computerId: string, desktop: boolean) => validate({ grantedOn: computerId, computerId, desktop });
    await expect(on(without.computerId, true)).rejects.toThrow(/has no desktop/);
    await expect(on(without.computerId, false)).resolves.toBeUndefined();
    await expect(on(withDesktop.computerId, true)).resolves.toBeUndefined();
    without.client.close();
    withDesktop.client.close();
  });

  it('is refused without a computer', async () => {
    const { computerId, client } = await desktopComputer();
    await expect(validate({ grantedOn: computerId, computerId: undefined, desktop: true })).rejects.toThrow(
      /needs sandbox.computer_id/,
    );
    client.close();
  });
});
