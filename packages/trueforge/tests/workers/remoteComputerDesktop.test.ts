/**
 * The desktop lease over a real relay Durable Object and a fake machine: who may drive the desktop,
 * who is refused and with what, and that a turn gives the lease back when it ends. Agent frames are
 * built by a real provider; a person's ops are hand-written until the routes that send them exist.
 */
import {
  AgentSpecSchema,
  CancellationReason,
  createInMemoryFileStore,
  Sessions,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createComputerDesktopsRouter } from '../../src/apis/computerDesktops';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import { desktopProviderTools } from '../../src/computers/desktopTools';
import {
  ClientOpRequestSchema,
  type ClientOpRequest,
  type ComputerCapabilities,
  type RequestOutcome,
} from '../../src/computers/protocol';
import { RemoteComputerProvider } from '../../src/computers/RemoteComputerProvider';
import { TurnDesktopLeases } from '../../src/computers/turnDesktopLeases';
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
import {
  connectNewComputer,
  FAKE_WORKDIR,
  PUBLIC_BASE_URL,
  settle,
  waitFor,
  type FakeComputerClient,
} from './remoteComputerClient';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'desktop-test' } });

const OTHER_TENANT = 'another-tenant';
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
    case 'cancel':
      return { cancelled: false };
    case 'file_get':
      return { data_b64: '', eof: true, size: 0, sha256: null };
    case 'file_put':
      return { bytes_written: 1, sha256: null };
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

/** Answers everything but the ops named, which the client holds until the test lets them go. */
function holding(...ops: string[]): (frame: Record<string, unknown>) => Record<string, unknown> | undefined {
  return frame => (ops.includes(String(frame['op'])) ? undefined : answer(frame));
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

async function desktopComputer(capabilities: ComputerCapabilities = WITH_DESKTOP) {
  return connectNewComputer({ name: unique('desktop-box'), options: { hello: { capabilities }, onRequest: answer } });
}

function relay(computerId: string) {
  return workersComputersService(env).relay(computerId);
}

/**
 * An agent session's turn on the computer. Every frame comes from a real provider; the outcome
 * each call returns is the relay's own, so a test can assert the exact refusal.
 */
function agentOn({
  computerId,
  sessionId,
  turnId = 'turn-1',
}: {
  computerId: string;
  sessionId: string;
  turnId?: string;
}) {
  const computers = workersComputersService(env);
  const real = computers.relay(computerId);
  const outcomes: RequestOutcome[] = [];
  const provider = new RemoteComputerProvider({
    relay: {
      ...real,
      request: async input => {
        const outcome = await real.request(input);
        outcomes.push(outcome);
        return outcome;
      },
    },
    computerId,
    computerName: 'desktop-box',
    tenantId: TENANT_ID,
    sessionId,
    turnId,
    workdir: FAKE_WORKDIR,
    capabilities: WITH_DESKTOP,
    requireApproval: false,
    defaultExecTimeoutSeconds: 2,
    fileMaxBytesForDownload: 1024 * 1024,
    store: computers.store,
    desktopLeases: undefined,
    logger,
  });
  const sandboxId = `${computerId}/${sessionId}`;
  const sessionFile = `${FAKE_WORKDIR}/${sessionId}/notes.txt`;
  /** The relay's answer to the one request `run` made. File ops throw on refusal; that is fine here. */
  const outcomeOf = async (run: () => Promise<unknown>): Promise<RequestOutcome> => {
    const before = outcomes.length;
    await run().catch(() => undefined);
    const outcome = outcomes[before];
    if (outcome === undefined) {
      throw new Error('the provider sent nothing');
    }
    return outcome;
  };
  return {
    screenshot: () => outcomeOf(() => provider.desktopScreenshot()),
    input: () => outcomeOf(() => provider.desktopInput([{ type: 'click', x: 10, y: 20, button: 'left', count: 1 }])),
    clipboardGet: () => outcomeOf(() => provider.desktopClipboardGet()),
    exec: () => outcomeOf(() => provider.exec({ sandboxId, command: 'true' })),
    /** What the model sees, for calls made in parallel, where outcomes cannot be matched to calls. */
    execResult: () => provider.exec({ sandboxId, command: 'true' }),
    fileGet: () => outcomeOf(() => provider.downloadFile({ sandboxId, path: sessionFile })),
    filePut: () =>
      outcomeOf(() => provider.uploadFile({ sandboxId, remotePath: sessionFile, content: Buffer.from('x') })),
  };
}

type AgentOp = Exclude<keyof ReturnType<typeof agentOn>, 'execResult'>;
const EVERY_AGENT_OP: AgentOp[] = ['screenshot', 'input', 'clipboardGet', 'exec', 'fileGet', 'filePut'];

/** A person's ops. No builder exists for them yet, so they are checked against the contract here. */
const HUMAN_OPS = {
  screenshot: { op: 'desktop_screenshot', quality: null },
  input: { op: 'desktop_input', actions: [{ type: 'click', x: 10, y: 20, button: 'left', count: 1 }] },
  clipboardGet: { op: 'desktop_clipboard_get' },
  exec: { op: 'exec', command: 'true', cwd: null, env: {}, timeout_ms: 1000 },
} satisfies Record<string, ClientOpRequest>;

function asHuman({
  computerId,
  userId,
  op,
}: {
  computerId: string;
  userId: string;
  op: ClientOpRequest;
}): Promise<RequestOutcome> {
  return relay(computerId).request({
    tenant_id: TENANT_ID,
    op_json: JSON.stringify(ClientOpRequestSchema.parse(op)),
    timeout_ms: 2000,
    principal: { kind: 'human', user_id: userId },
  });
}

function relayStub(computerId: string) {
  return env.REMOTE_COMPUTER_DO.get(env.REMOTE_COMPUTER_DO.idFromName(computerId));
}

function takeControl({
  computerId,
  userId,
  tenantId = TENANT_ID,
}: {
  computerId: string;
  userId: string;
  tenantId?: string;
}) {
  return relayStub(computerId).takeHumanLease({ tenant_id: tenantId, user_id: userId });
}

function handBack({
  computerId,
  userId,
  tenantId = TENANT_ID,
}: {
  computerId: string;
  userId: string;
  tenantId?: string;
}) {
  return relayStub(computerId).releaseHumanLease({ tenant_id: tenantId, user_id: userId });
}

function releaseTurn({
  computerId,
  sessionId,
  turnId = 'turn-1',
  tenantId = TENANT_ID,
}: {
  computerId: string;
  sessionId: string;
  turnId?: string;
  tenantId?: string;
}) {
  return relayStub(computerId).releaseLease({ tenant_id: tenantId, session_id: sessionId, turn_id: turnId });
}

function refusedWith(outcome: RequestOutcome): string | undefined {
  return outcome.ok ? undefined : outcome.reason;
}

function desktopFrames(client: FakeComputerClient) {
  return client.received.filter(frame => String(frame['op']).startsWith('desktop_'));
}

function clears(client: FakeComputerClient) {
  return client.received.filter(frame => frame['op'] === 'desktop_clipboard_set');
}

function readStoredLease(computerId: string) {
  return runInDurableObject(relayStub(computerId), (_instance, state) => state.storage.get('desktop_lease'));
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
    const agent = agentOn({ computerId, sessionId: 's-1' });

    const outcome = await agent.screenshot();
    expect(refusedWith(outcome)).toBe('desktop_unavailable');
    expect(outcome.ok ? '' : outcome.message).toContain('Xvfb did not start');
    await expect(takeControl({ computerId, userId: 'u-1' })).resolves.toMatchObject({
      ok: false,
      reason: 'desktop_unavailable',
    });
    // Commands still run: only the desktop is missing.
    expect((await agent.exec()).ok).toBe(true);
    expect(desktopFrames(client)).toHaveLength(0);
    client.close();
  });

  it('sends desktop ops the client can parse, on the contract', async () => {
    const { computerId, client } = await desktopComputer();
    const agent = agentOn({ computerId, sessionId: 's-1' });
    for (const op of ['screenshot', 'input', 'clipboardGet'] as const) {
      expect((await agent[op]()).ok).toBe(true);
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
    const first = agentOn({ computerId, sessionId: 's-a' });
    const second = agentOn({ computerId, sessionId: 's-b' });

    expect((await first.screenshot()).ok).toBe(true);
    expect(refusedWith(await second.screenshot())).toBe('desktop_busy');
    expect(refusedWith(await second.input())).toBe('desktop_busy');
    // `exec` never needs the agent lease.
    expect((await second.exec()).ok).toBe(true);
    // The holder keeps working.
    expect((await first.input()).ok).toBe(true);

    // Only the holder's own turn, in its own tenant, can let go.
    await expect(releaseTurn({ computerId, sessionId: 's-b' })).resolves.toEqual({ released: false });
    await expect(releaseTurn({ computerId, sessionId: 's-a', turnId: 'turn-2' })).resolves.toEqual({
      released: false,
    });
    await expect(releaseTurn({ computerId, sessionId: 's-a', tenantId: OTHER_TENANT })).resolves.toEqual({
      released: false,
    });
    expect(refusedWith(await second.screenshot())).toBe('desktop_busy');
    await expect(releaseTurn({ computerId, sessionId: 's-a' })).resolves.toEqual({ released: true });
    expect((await second.screenshot()).ok).toBe(true);
    client.close();
  });

  it("ignores a late release from a session's earlier turn once its next turn holds the desktop", async () => {
    const { computerId, client } = await desktopComputer();
    expect((await agentOn({ computerId, sessionId: 's-a', turnId: 'turn-1' }).screenshot()).ok).toBe(true);
    // The next turn of the same session carries on with the desktop and becomes the holder.
    expect((await agentOn({ computerId, sessionId: 's-a', turnId: 'turn-2' }).screenshot()).ok).toBe(true);

    await expect(releaseTurn({ computerId, sessionId: 's-a', turnId: 'turn-1' })).resolves.toEqual({
      released: false,
    });
    const other = agentOn({ computerId, sessionId: 's-b' });
    expect(refusedWith(await other.screenshot())).toBe('desktop_busy');
    await expect(releaseTurn({ computerId, sessionId: 's-a', turnId: 'turn-2' })).resolves.toEqual({
      released: true,
    });
    expect((await other.screenshot()).ok).toBe(true);
    client.close();
  });

  it('keeps the lease across an eviction, so another session is still refused', async () => {
    const { computerId, client } = await desktopComputer();
    expect((await agentOn({ computerId, sessionId: 's-a' }).screenshot()).ok).toBe(true);

    await evictDurableObject(relayStub(computerId));

    expect(refusedWith(await agentOn({ computerId, sessionId: 's-b' }).screenshot())).toBe('desktop_busy');
    client.close();
  });

  it('answers offline, and takes no lease, when the machine is gone', async () => {
    const { computerId, client } = await desktopComputer();
    client.close();
    for (let attempt = 0; attempt < 200 && (await relay(computerId).status()).connected; attempt += 1) {
      await settle(2);
    }

    expect(refusedWith(await agentOn({ computerId, sessionId: 's-a' }).screenshot())).toBe('offline');
    expect(await readStoredLease(computerId)).toBeUndefined();
  });

  it('lets a person preempt an agent, and refuses every agent op but cancel while they hold it', async () => {
    const { computerId, client } = await desktopComputer();
    expect((await agentOn({ computerId, sessionId: 's-a' }).screenshot()).ok).toBe(true);

    await expect(takeControl({ computerId, userId: 'u-1' })).resolves.toEqual({ ok: true });
    const framesAtTakeover = client.received.length;

    // The agent that held it, and every other agent, now sees nothing and runs nothing.
    for (const sessionId of ['s-a', 's-b']) {
      const agent = agentOn({ computerId, sessionId });
      for (const op of EVERY_AGENT_OP) {
        expect({ sessionId, op, reason: refusedWith(await agent[op]()) }).toEqual({
          sessionId,
          op,
          reason: 'human_in_control',
        });
      }
    }
    expect(client.received.length).toBe(framesAtTakeover);
    // Cancelling a command already running is still allowed: it only stops agent work.
    const cancelled = await relay(computerId).request({
      tenant_id: TENANT_ID,
      op_json: JSON.stringify({ op: 'cancel', target_id: 'some-exec' }),
      timeout_ms: 1000,
      principal: { kind: 'agent', session_id: 's-a', turn_id: 'turn-1' },
    });
    expect(cancelled.ok).toBe(true);

    // The person in control drives it.
    for (const op of [HUMAN_OPS.screenshot, HUMAN_OPS.input, HUMAN_OPS.clipboardGet]) {
      expect((await asHuman({ computerId, userId: 'u-1', op })).ok).toBe(true);
    }
    // Another person neither sees nor drives it.
    for (const op of [HUMAN_OPS.screenshot, HUMAN_OPS.input]) {
      expect(refusedWith(await asHuman({ computerId, userId: 'u-2', op }))).toBe('human_in_control');
    }
    // A lease release from the agent's turn does not end the person's control.
    await expect(releaseTurn({ computerId, sessionId: 's-a' })).resolves.toEqual({ released: false });
    client.close();
  });

  it('refuses a queued command when a person took control while it waited for a slot', async () => {
    const { computerId, client } = await desktopComputer();
    client.answerWith(holding('exec'));
    const agent = agentOn({ computerId, sessionId: 's-a' });

    // Four fill the slots; the fifth waits in the queue.
    const running = Array.from({ length: 5 }, () => agent.execResult());
    await waitFor(() => client.received.filter(frame => frame['op'] === 'exec').length === 4);
    await expect(takeControl({ computerId, userId: 'u-1' })).resolves.toEqual({ ok: true });

    client.releaseHeld(OK_EXEC);
    const results = await Promise.all(running);

    expect(results.filter(result => result.success)).toHaveLength(4);
    const errors = results.flatMap(result => (result.success ? [] : [result.error]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^A person is using the desktop/);
    expect(client.received.filter(frame => frame['op'] === 'exec')).toHaveLength(4);
    client.close();
  });

  it('lets anyone watch while nobody holds control, but only the controller type or read the clipboard', async () => {
    const { computerId, client } = await desktopComputer();
    const agent = agentOn({ computerId, sessionId: 's-a' });
    expect((await asHuman({ computerId, userId: 'u-1', op: HUMAN_OPS.screenshot })).ok).toBe(true);
    expect(refusedWith(await asHuman({ computerId, userId: 'u-1', op: HUMAN_OPS.input }))).toBe('forbidden');
    expect(refusedWith(await asHuman({ computerId, userId: 'u-1', op: HUMAN_OPS.clipboardGet }))).toBe('forbidden');
    // Watching takes no lease, so an agent can still start.
    expect((await agent.input()).ok).toBe(true);
    // A person may watch an agent at work.
    expect((await asHuman({ computerId, userId: 'u-1', op: HUMAN_OPS.screenshot })).ok).toBe(true);
    // A person sends desktop ops only.
    expect(refusedWith(await asHuman({ computerId, userId: 'u-1', op: HUMAN_OPS.exec }))).toBe('forbidden');
    client.close();
  });

  it('refuses the lease calls of another tenant', async () => {
    const { computerId, client } = await desktopComputer();
    await expect(takeControl({ computerId, userId: 'u-1', tenantId: OTHER_TENANT })).resolves.toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
    await expect(takeControl({ computerId, userId: 'u-1' })).resolves.toEqual({ ok: true });
    await expect(handBack({ computerId, userId: 'u-1', tenantId: OTHER_TENANT })).resolves.toEqual({
      released: false,
      clipboard_cleared: false,
    });
    expect(refusedWith(await agentOn({ computerId, sessionId: 's-a' }).screenshot())).toBe('human_in_control');
    expect(clears(client)).toHaveLength(0);
    client.close();
  });

  it('keeps everyone off the desktop until the clipboard clear after a hand-back is confirmed', async () => {
    const { computerId, client } = await desktopComputer();
    await takeControl({ computerId, userId: 'u-1' });
    await expect(handBack({ computerId, userId: 'u-2' })).resolves.toEqual({
      released: false,
      clipboard_cleared: false,
    });

    client.answerWith(holding('desktop_clipboard_set'));
    const handedBack = handBack({ computerId, userId: 'u-1' });
    await waitFor(() => clears(client).length === 1);
    expect(clears(client)[0]).toMatchObject({ text: '', selections: ['clipboard', 'primary'] });

    // The person no longer holds it, and nobody else has it yet.
    const agent = agentOn({ computerId, sessionId: 's-a' });
    expect(refusedWith(await agent.screenshot())).toBe('desktop_busy');
    expect(refusedWith(await agent.exec())).toBe('desktop_busy');
    expect(refusedWith(await asHuman({ computerId, userId: 'u-1', op: HUMAN_OPS.screenshot }))).toBe('desktop_busy');

    client.answerWith(answer);
    client.releaseHeld({ ok: true });
    await expect(handedBack).resolves.toEqual({ released: true, clipboard_cleared: true });
    expect((await agent.screenshot()).ok).toBe(true);
    expect(clears(client)).toHaveLength(1);
    client.close();
  });

  it('hands control from one person to another only after the first clipboard is cleared', async () => {
    const { computerId, client } = await desktopComputer();
    await takeControl({ computerId, userId: 'u-1' });
    client.answerWith(holding('desktop_clipboard_set'));

    let taken = false;
    const takeover = takeControl({ computerId, userId: 'u-2' }).then(outcome => {
      taken = true;
      return outcome;
    });
    await waitFor(() => clears(client).length === 1);
    await settle();
    expect(taken).toBe(false);
    for (const userId of ['u-1', 'u-2']) {
      expect(refusedWith(await asHuman({ computerId, userId, op: HUMAN_OPS.input }))).toBe('desktop_busy');
    }

    client.answerWith(answer);
    client.releaseHeld({ ok: true });
    await expect(takeover).resolves.toEqual({ ok: true });
    expect((await asHuman({ computerId, userId: 'u-2', op: HUMAN_OPS.input })).ok).toBe(true);
    // The clear went out before anything the second person sent.
    const ops = client.received.map(frame => frame['op']);
    expect(ops.indexOf('desktop_clipboard_set')).toBeLessThan(ops.lastIndexOf('desktop_input'));
    client.close();
  });

  it('stays clearing after a clear that failed, and sends it again on the next op and on the alarm', async () => {
    const { computerId, client } = await desktopComputer();
    await takeControl({ computerId, userId: 'u-1' });
    client.answerWith(holding('desktop_clipboard_set'));
    const handedBack = handBack({ computerId, userId: 'u-1' });
    await waitFor(() => client.held.length === 1);
    // The machine answers the clear with an error, so the person's text may still be there.
    for (const id of client.held.splice(0)) {
      client.sendRaw(JSON.stringify({ id, error: { code: 'op_failed', message: 'xclip exited' } }));
    }
    await expect(handedBack).resolves.toEqual({ released: true, clipboard_cleared: false });

    // The refused op sends the clear again; this one is held, and is answered with an error too.
    const agent = agentOn({ computerId, sessionId: 's-a' });
    expect(refusedWith(await agent.screenshot())).toBe('desktop_busy');
    await waitFor(() => client.held.length === 1);
    for (const id of client.held.splice(0)) {
      client.sendRaw(JSON.stringify({ id, error: { code: 'op_failed', message: 'xclip exited' } }));
    }
    await settle();
    expect(refusedWith(await agent.exec())).toBe('desktop_busy');
    await waitFor(() => client.held.length === 1);
    for (const id of client.held.splice(0)) {
      client.sendRaw(JSON.stringify({ id, error: { code: 'op_failed', message: 'xclip exited' } }));
    }
    await settle();

    // The alarm retries with nobody asking; this time the machine confirms.
    client.answerWith(answer);
    const before = clears(client).length;
    await runInDurableObject(relayStub(computerId), instance => instance.alarm());
    await waitFor(() => clears(client).length === before + 1);
    await settle();
    expect(await readStoredLease(computerId)).toBeUndefined();
    expect((await agent.screenshot()).ok).toBe(true);
    client.close();
  });

  it('ends clearing when the machine answers the clear with read_only or desktop_unavailable', async () => {
    for (const code of ['read_only', 'desktop_unavailable']) {
      const { computerId, client } = await desktopComputer();
      await takeControl({ computerId, userId: 'u-1' });
      client.answerWith(holding('desktop_clipboard_set'));
      const handedBack = handBack({ computerId, userId: 'u-1' });
      await waitFor(() => client.held.length === 1);
      for (const id of client.held.splice(0)) {
        client.sendRaw(JSON.stringify({ id, error: { code, message: 'refused' } }));
      }
      // Nothing is left to clear: a read-only machine never set it, and a restarted X dropped it.
      await expect(handedBack).resolves.toEqual({ released: true, clipboard_cleared: true });
      await settle();
      expect({ code, lease: await readStoredLease(computerId) }).toEqual({ code, lease: undefined });
      client.answerWith(answer);
      expect((await agentOn({ computerId, sessionId: 's-a' }).screenshot()).ok).toBe(true);
      expect(clears(client)).toHaveLength(1);
      client.close();
    }
  });

  it('lets commands and file transfers through after three failed clears, but not the desktop until one succeeds', async () => {
    const { computerId, client } = await desktopComputer();
    await takeControl({ computerId, userId: 'u-1' });
    client.answerWith(holding('desktop_clipboard_set'));
    const failHeldClear = async () => {
      await waitFor(() => client.held.length === 1);
      for (const id of client.held.splice(0)) {
        client.sendRaw(JSON.stringify({ id, error: { code: 'op_failed', message: 'xclip exited' } }));
      }
      await settle();
    };
    const handedBack = handBack({ computerId, userId: 'u-1' });
    await failHeldClear();
    await expect(handedBack).resolves.toEqual({ released: true, clipboard_cleared: false });
    const agent = agentOn({ computerId, sessionId: 's-a' });
    expect(refusedWith(await agent.screenshot())).toBe('desktop_busy');
    await failHeldClear();
    expect(refusedWith(await agent.exec())).toBe('desktop_busy');
    await failHeldClear();
    expect(await readStoredLease(computerId)).toEqual({ kind: 'clearing', failed_clears: 3 });

    // The count is stored, so a woken object lets commands through too.
    await evictDurableObject(relayStub(computerId));
    for (const op of ['exec', 'fileGet', 'filePut'] as const) {
      expect({ op, ok: (await agent[op]()).ok }).toEqual({ op, ok: true });
    }
    for (const op of ['screenshot', 'input', 'clipboardGet'] as const) {
      expect({ op, reason: refusedWith(await agent[op]()) }).toEqual({ op, reason: 'desktop_busy' });
    }

    // Those ops sent the clear again; once the machine confirms it, the desktop is back.
    client.answerWith(answer);
    client.releaseHeld({ ok: true });
    await settle();
    expect(await readStoredLease(computerId)).toBeUndefined();
    expect((await agent.screenshot()).ok).toBe(true);
    client.close();
  });

  it('refuses a person on a computer that never connected, so it has no tenant', async () => {
    await expect(takeControl({ computerId: unique('never-connected'), userId: 'u-1' })).resolves.toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('expires an idle agent lease after ten minutes, and an idle person after five with the clipboard cleared', async () => {
    const { computerId, client } = await desktopComputer();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);

    expect((await agentOn({ computerId, sessionId: 's-a' }).screenshot()).ok).toBe(true);
    offset = 9 * 60_000;
    expect(refusedWith(await agentOn({ computerId, sessionId: 's-b' }).screenshot())).toBe('desktop_busy');
    offset = 11 * 60_000;
    expect((await agentOn({ computerId, sessionId: 's-b' }).screenshot()).ok).toBe(true);

    offset = 0;
    await takeControl({ computerId, userId: 'u-1' });
    // Only the alarm's lease check sees the future: its heartbeat check must still see a live socket.
    clock.mockImplementationOnce(() => realNow() + 6 * 60_000);
    // The relay's own alarm ends a person's control even when nobody else asks for the desktop.
    await runInDurableObject(relayStub(computerId), instance => instance.alarm());
    await waitFor(() => clears(client).length === 1);
    await settle();
    expect((await agentOn({ computerId, sessionId: 's-a' }).screenshot()).ok).toBe(true);
    client.close();
  });

  it('reports who controls the desktop in its status', async () => {
    const { computerId, client } = await desktopComputer();
    await expect(relay(computerId).status()).resolves.toMatchObject({ desktop_control: { kind: 'none' } });

    expect((await agentOn({ computerId, sessionId: 's-a' }).screenshot()).ok).toBe(true);
    await expect(relay(computerId).status()).resolves.toMatchObject({
      desktop_control: { kind: 'agent', session_id: 's-a' },
    });

    const before = Date.now();
    await takeControl({ computerId, userId: 'u-1' });
    const held = (await relay(computerId).status()).desktop_control;
    expect(held).toMatchObject({ kind: 'human', user_id: 'u-1' });
    const expiresAt = held.kind === 'human' ? held.expires_at : 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

    client.answerWith(holding('desktop_clipboard_set'));
    const handedBack = handBack({ computerId, userId: 'u-1' });
    await waitFor(() => clears(client).length === 1);
    await expect(relay(computerId).status()).resolves.toMatchObject({ desktop_control: { kind: 'clearing' } });
    client.answerWith(answer);
    client.releaseHeld({ ok: true });
    await handedBack;
    await expect(relay(computerId).status()).resolves.toMatchObject({ desktop_control: { kind: 'none' } });
    client.close();
  });
});

describe('the desktop routes over a real relay', () => {
  /** A tenant admin, so the routes skip the agent checks the unit tests cover and reach the relay. */
  function desktopsApp() {
    return createComputerDesktopsRouter({
      computers: workersComputersService(env),
      humanTakeovers: undefined,
      resolveRequestContext: c => {
        const user = c.req.header('x-test-user') ?? 'u-1';
        return {
          tenant_id: TENANT_ID,
          subject: { id: user, type: 'user', display_name: user },
          roles: ['admin'],
          user_credential: null,
        };
      },
      resolveAgentStore: () => d1Persistence().agentStore,
      authorizer: new TrueForgeAuthorizer(),
      publicBaseUrl: () => PUBLIC_BASE_URL,
      logger,
    });
  }

  function send({
    computerId,
    path = '',
    method = 'GET',
    user = 'u-1',
    body,
  }: {
    computerId: string;
    path?: string;
    method?: string;
    user?: string;
    body?: unknown;
  }) {
    return desktopsApp().request(`/${computerId}${path}`, {
      method,
      headers: {
        'x-test-user': user,
        Origin: PUBLIC_BASE_URL,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('lets a person take the desktop from an agent, drive it alone, and hand it back', async () => {
    const { computerId, client } = await desktopComputer();
    const agent = agentOn({ computerId, sessionId: 's-a' });
    expect((await agent.screenshot()).ok).toBe(true);

    const taken = await send({ computerId, method: 'POST', path: '/take-control' });
    expect(taken.status).toBe(200);
    await expect(taken.json()).resolves.toMatchObject({
      data: { online: true, desktop: true, controller: { kind: 'human', user_id: 'u-1', is_me: true } },
    });
    expect(refusedWith(await agent.screenshot())).toBe('human_in_control');

    const typed = await send({
      computerId,
      method: 'POST',
      path: '/input',
      body: { actions: [{ type: 'type', text: 'hello' }] },
    });
    expect(typed.status).toBe(200);
    expect(typed.headers.get('Content-Type')).toBe('image/jpeg');
    expect(
      desktopFrames(client)
        .slice(-2)
        .map(frame => frame['op']),
    ).toEqual(['desktop_input', 'desktop_screenshot']);

    const watched = await send({ computerId, path: '/screenshot', user: 'u-2' });
    expect(watched.status).toBe(423);
    await expect(watched.json()).resolves.toMatchObject({ error: { code: 'human_in_control' } });
    expect(
      (
        await send({
          computerId,
          method: 'POST',
          path: '/input',
          user: 'u-2',
          body: { actions: [{ type: 'key', keys: 'a' }] },
        })
      ).status,
    ).toBe(423);

    const handedBack = await send({ computerId, method: 'POST', path: '/hand-back', body: {} });
    expect(handedBack.status).toBe(200);
    await expect(handedBack.json()).resolves.toMatchObject({ data: { controller: { kind: 'none' } } });
    expect(clears(client)).toHaveLength(1);
    expect((await agent.screenshot()).ok).toBe(true);
    client.close();
  });

  it('answers 503 for a computer whose machine has gone', async () => {
    const { computerId, client } = await desktopComputer();
    client.close();
    for (let attempt = 0; attempt < 200 && (await relay(computerId).status()).connected; attempt += 1) {
      await settle(2);
    }
    const response = await send({ computerId, path: '/screenshot' });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'offline' } });
  });
});

function computerIntegration(desktopLeases?: TurnDesktopLeases) {
  return createWorkersSandboxIntegration({
    backend: undefined,
    computers: workersComputersService(env),
    namespace: env.COMPUTER_DO,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 1024 * 1024,
    codeModeRegistry: undefined,
    desktopLeases,
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

/** A turn run in-process, with the drained hook the session Durable Object wires, or none. */
async function startDesktopTurn({
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
  const desktopLeases = new TurnDesktopLeases();
  const activeTurns = new ActiveTurnRegistry();
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
      activeTurns,
      eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
      logger,
      sandboxIntegration: computerIntegration(desktopLeases),
      fileStore: createInMemoryFileStore(),
      onTurnDrained: withHook
        ? createTurnDrainedHook({
            deliver: () => Promise.resolve(),
            desktop: { computers: workersComputersService(env), leases: desktopLeases, agentStore: stores.agentStore },
            logger,
          })
        : undefined,
    },
  });
  const finished = async () => {
    await started.drained;
    return stores.sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.record.turn_id });
  };
  return { turnId: started.turn.record.turn_id, activeTurns, finished };
}

describe('a desktop turn', () => {
  it('takes the lease with its first screenshot and keeps it when nothing releases it', async () => {
    const { computerId, client } = await desktopComputer();
    const { stores, sessionId } = await desktopAgentSession({ computerId });

    const finished = await (await startDesktopTurn({ stores, sessionId, withHook: false })).finished();

    expect(finished?.state.status).toBe('done');
    expect(client.received.some(frame => frame['op'] === 'desktop_screenshot')).toBe(true);
    // Images do not reach the model yet; the stub says what was captured.
    expect(JSON.stringify(finished?.snapshot.threads ?? {})).toContain(
      '[screenshot 1280x800 captured; this model does not receive images yet]',
    );
    // A screenshot-only session still records its sandbox, so its next turn works in the same directory.
    expect(finished?.snapshot.sandbox_info?.sandbox_id).toBe(`v1:remote-computer:${computerId}/${sessionId}`);
    expect(refusedWith(await agentOn({ computerId, sessionId: 'someone-else' }).screenshot())).toBe('desktop_busy');
    client.close();
  });

  it('releases the lease when the turn drains', async () => {
    const { computerId, client } = await desktopComputer();
    const { stores, sessionId } = await desktopAgentSession({ computerId });

    const finished = await (await startDesktopTurn({ stores, sessionId, withHook: true })).finished();

    expect(finished?.state.status).toBe('done');
    expect(client.received.some(frame => frame['op'] === 'desktop_screenshot')).toBe(true);
    expect((await agentOn({ computerId, sessionId: 'someone-else' }).screenshot()).ok).toBe(true);
    client.close();
  });

  it('releases the lease when the turn is cancelled in the middle of a desktop op', async () => {
    const { computerId, client } = await desktopComputer();
    client.answerWith(holding('desktop_screenshot'));
    const { stores, sessionId } = await desktopAgentSession({ computerId });

    const turn = await startDesktopTurn({ stores, sessionId, withHook: true });
    // A model round trip comes first, so this waits on the clock rather than on a few ticks.
    for (let attempt = 0; attempt < 200 && client.held.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(client.held).toHaveLength(1);
    // The relay has already given this turn the lease.
    expect(refusedWith(await agentOn({ computerId, sessionId: 'someone-else' }).screenshot())).toBe('desktop_busy');
    expect(
      turn.activeTurns.cancelIfRunning({
        sessionId,
        turnId: turn.turnId,
        abortReason: CancellationReason.ClientCancelled,
      }),
    ).toBe(true);
    client.answerWith(answer);
    client.releaseHeld(SCREENSHOT);

    const finished = await turn.finished();
    expect(finished?.state.status).toBe('cancelled');
    expect((await agentOn({ computerId, sessionId: 'someone-else' }).screenshot()).ok).toBe(true);
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
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const turn = await d1Persistence().sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.id });
      if (turn?.state.status !== 'running' && (await readStoredLease(computerId)) === undefined) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const finished = await d1Persistence().sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.id });
    expect(finished?.state.status).toBe('done');
    expect(client.received.some(frame => frame['op'] === 'desktop_screenshot')).toBe(true);
    expect(await readStoredLease(computerId)).toBeUndefined();
    expect((await agentOn({ computerId, sessionId: 'someone-else' }).screenshot()).ok).toBe(true);
    client.close();
  });
});

describe('a desktop agent spec', () => {
  async function validate({
    grantedOn,
    computerId,
    desktop,
    requireApproval = false,
  }: {
    grantedOn: string;
    computerId: string | undefined;
    desktop: boolean;
    requireApproval?: boolean;
  }) {
    const { stores, agentId, providerName } = await desktopAgentSession({ computerId: grantedOn, requireApproval });
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

  it('on a computer that requires approval, is accepted but offered only the screenshot and clipboard read', async () => {
    const { computerId, client } = await desktopComputer();
    // Spec validation has no warning channel, so the reason reaches the model through the instructions.
    await expect(
      validate({ grantedOn: computerId, computerId, desktop: true, requireApproval: true }),
    ).resolves.toBeUndefined();

    const provider = await computerIntegration().resolveProvider({
      tenant_id: TENANT_ID,
      store: d1Persistence().sandboxProviderStore,
      sessionId: unique('approval-session'),
      computer_id: computerId,
      turn_id: 'turn-1',
      logger,
    });
    if (!(provider instanceof RemoteComputerProvider)) {
      throw new Error('expected the remote computer provider');
    }
    const offered = desktopProviderTools(provider);
    expect(offered.tools.map(candidate => candidate.name).sort()).toEqual([
      'computer_clipboard_read',
      'computer_screenshot',
    ]);
    expect(offered.instructions).toContain('approve each action');
    client.close();
  });
});
