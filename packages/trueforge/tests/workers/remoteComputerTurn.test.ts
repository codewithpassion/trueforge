/**
 * A whole turn on a machine the tenant enrolled: a saved agent with `sandbox.computer_id` runs its
 * command through the fake client, and the allowlist is enforced again when the turn starts.
 */
import { AgentSpecSchema, Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { env } from 'cloudflare:workers';
import { computerSessionDirectory, type ComputersService } from '../../src/computers/service';
import { D1_MAX_VALUE_BYTES } from '../../src/db/d1/client';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { validateAgentSpec } from '../../src/runtime/sessionResources';
import { startTurnInProcess } from '../../src/runtime/turnRunner';
import { newId } from '../../src/utils/id';
import { workersComputersService } from '../../src/workers/computersService';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersSandboxIntegration } from '../../src/workers/sandbox/workersSandboxIntegration';
import { d1Persistence, migrateDatabase, TENANT_ID, upsertMockProvider, USER_REF } from './harness';
import { computersApp, FAKE_WORKDIR, FakeComputerClient, PUBLIC_BASE_URL, settle } from './remoteComputerClient';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'computer-turn-test' } });

const OK_EXEC = { exit_code: 0, stdout: '', stderr: '', bytes_total: 0, truncated: false, duration_ms: 1 };
const OTHER_TENANT = 'someone-else';
/** Distinctive enough that finding it in the turn proves it came off the machine. */
const UNAME_OUTPUT = 'Linux office-box 6.1.0 #1 SMP x86_64 GNU/Linux\n';

function computerIntegration(computers: ComputersService = workersComputersService(env)) {
  return createWorkersSandboxIntegration({
    backend: undefined,
    computers,
    namespace: env.COMPUTER_DO,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 1024 * 1024,
    codeModeRegistry: undefined,
  });
}

/** Creates a computer through the API, enrolls it, and connects a client that answers commands. */
async function onlineComputer(
  name: string,
  /** What the machine says about the skill downloader. The default machine can run it. */
  skills = true,
): Promise<{ computerId: string; client: FakeComputerClient }> {
  const computers = workersComputersService(env);
  const app = computersApp({ computers });
  const created = await app.fetch(
    new Request(`${PUBLIC_BASE_URL}/api/v1/computers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    env,
  );
  const body = await created.json<{ data: { computer: { id: string }; enrollment: { enrollment_code: string } } }>();
  const enrolled = await app.fetch(
    new Request(`${PUBLIC_BASE_URL}/api/v1/computers/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollment_code: body.data.enrollment.enrollment_code,
        hostname: 'office-box',
        os: 'linux',
        arch: 'amd64',
        version: '0.1.0-test',
      }),
    }),
    env,
  );
  const credential = (await enrolled.json<{ data: { machine_credential: string } }>()).data.machine_credential;
  const client = await FakeComputerClient.connect({
    app,
    credential,
    options: {
      // python3 and git are always there: the machine the live test found had both and no
      // pydantic, so only `skills` varies — a server that re-derived it would still pass.
      hello: { capabilities: { python3: true, git: true, skills } },
      onRequest: frame =>
        frame['op'] === 'exec'
          ? { ...OK_EXEC, stdout: String(frame['command']).includes('uname') ? UNAME_OUTPUT : '' }
          : undefined,
    },
  });
  // The hello write is what turns the row online and tells the provider where sessions live.
  await settle();
  return { computerId: body.data.computer.id, client };
}

function computerSpec({
  providerName,
  computerId,
  skillName,
}: {
  providerName: string;
  computerId: string;
  skillName?: string;
}) {
  return AgentSpecSchema.parse({
    model: { name: `${providerName}/mock-model` },
    instructions: 'test',
    ...(skillName === undefined ? {} : { skills: [{ name: skillName }] }),
    config: { sandbox: { enabled: true, file_downloads: false, computer_id: computerId } },
  });
}

async function runTurn({
  sessionId,
  stores,
  computers,
}: {
  sessionId: string;
  stores: ReturnType<typeof d1Persistence>;
  computers?: ComputersService;
}) {
  const session = await new Sessions({ sessionStore: stores.sessionStore }).get({
    tenant_id: TENANT_ID,
    session_id: sessionId,
  });
  if (session === undefined) {
    throw new Error('expected the session that was just created');
  }
  const started = await startTurnInProcess({
    session,
    turn_id: newId(),
    input: [{ type: 'user.message', content: 'hello' }],
    previous_turn_id: undefined,
    userRef: USER_REF,
    deps: {
      agentStore: stores.agentStore,
      modelProviderStore: stores.modelProviderStore,
      mcpServerStore: stores.mcpServerStore,
      sandboxProviderStore: stores.sandboxProviderStore,
      skillStore: stores.skillStore,
      activeTurns: new ActiveTurnRegistry(),
      eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
      logger,
      sandboxIntegration: computerIntegration(computers),
      onTurnDrained: undefined,
    },
  });
  await started.drained;
  return stores.sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.record.turn_id });
}

/** A saved agent bound to a computer, and a session that references it by name. */
async function agentOnComputer({
  computerId,
  agentName,
  sessionId,
  allowed,
  skillName,
}: {
  computerId: string;
  agentName: string;
  sessionId: string;
  allowed: boolean;
  skillName?: string;
}) {
  const stores = d1Persistence();
  const computers = workersComputersService(env);
  const providerName = await upsertMockProvider({ stores, scenario: 'sandbox' });
  const agent = await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: agentName,
    description: 'runs on a machine',
    manifest: computerSpec({ providerName, computerId, ...(skillName === undefined ? {} : { skillName }) }),
    external_id: null,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
  });
  await computers.store.putAgentAccess({
    tenant_id: TENANT_ID,
    computer_id: computerId,
    agents: allowed ? [{ agent_id: agent.id, agent_name: agent.name }] : [],
  });
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: sessionId,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
    agent: { type: 'reference', id: agent.id, name: agent.name },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  return { stores, providerName, computers, agent };
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('a turn on a remote computer', () => {
  it('runs the command on the machine, in the session directory, and records it', async () => {
    const name = unique('turn-box');
    const { computerId, client } = await onlineComputer(name);
    const agentName = unique('turn-agent');
    const sessionId = `computer-turn-${newId()}`;
    const { stores, computers } = await agentOnComputer({ computerId, agentName, sessionId, allowed: true });

    const finished = await runTurn({ sessionId, stores });
    expect(finished?.state.status).toBe('done');

    // The model's sandbox command reached the machine over the wire, in this session's directory,
    // which hangs off the sessions root the machine itself reported.
    const execFrames = client.received.filter(frame => frame['op'] === 'exec');
    expect(execFrames.length).toBeGreaterThan(1);
    const expectedCwd = computerSessionDirectory({ workdir: FAKE_WORKDIR, sessionId });
    expect(expectedCwd.startsWith(FAKE_WORKDIR)).toBe(true);
    // The command that makes the session directory cannot run inside it, so it names no cwd.
    expect(execFrames[0]).toMatchObject({ cwd: null });
    expect(String(execFrames[0]?.['command'])).toContain(expectedCwd);
    expect(execFrames.slice(1).some(frame => frame['cwd'] === expectedCwd)).toBe(true);
    // Every path the turn hands the machine sits under the same root; nothing is derived from
    // the run-as user or a home directory this server guessed at.
    for (const frame of client.received) {
      const path = frame['path'];
      if (typeof path === 'string') {
        expect(path.startsWith(`${expectedCwd}/`)).toBe(true);
      }
    }

    // And the turn carries a reference that names both the machine and the session.
    expect(finished?.snapshot.sandbox_info?.sandbox_id).toBe(`v1:remote-computer:${computerId}/${sessionId}`);

    const audit = await computers.store.listAudit({
      tenant_id: TENANT_ID,
      computer_id: computerId,
      limit: 50,
      before_id: undefined,
    });
    expect(audit.some(row => row.op === 'exec' && row.session_id === sessionId)).toBe(true);
    client.close();
  });

  it('refuses at turn time once the agent is taken off the allowlist', async () => {
    const { computerId, client } = await onlineComputer(unique('revoked-access-box'));
    const agentName = unique('revoked-access-agent');
    const sessionId = `computer-turn-denied-${newId()}`;
    const { stores } = await agentOnComputer({ computerId, agentName, sessionId, allowed: false });

    // The refusal comes out of `createTurn`, which the create-turn route answers with its status.
    await expect(runTurn({ sessionId, stores })).rejects.toThrow(/not allowed to use computer/);
    expect(client.received.filter(frame => frame['op'] === 'exec')).toHaveLength(0);
    client.close();
  });

  it('refuses a revoked computer at turn time', async () => {
    const { computerId, client } = await onlineComputer(unique('revoked-box'));
    const agentName = unique('revoked-agent');
    const sessionId = `computer-turn-revoked-${newId()}`;
    const { stores, computers } = await agentOnComputer({ computerId, agentName, sessionId, allowed: true });
    await computers.store.revokeComputer({ tenant_id: TENANT_ID, computer_id: computerId });

    await expect(runTurn({ sessionId, stores })).rejects.toThrow(/revoked/);
    client.close();
  });

  it('refuses a computer that belongs to another tenant, at validation and at turn time', async () => {
    // Enrolled by, and granted to, a different tenant entirely.
    const computers = workersComputersService(env);
    const foreignApp = computersApp({ computers, tenantId: OTHER_TENANT });
    const created = await foreignApp.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: unique('foreign-box') }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const computerId = (await created.json<{ data: { computer: { id: string } } }>()).data.computer.id;
    const agentName = unique('foreign-agent');
    await computers.store.putAgentAccess({
      tenant_id: OTHER_TENANT,
      computer_id: computerId,
      agents: [{ agent_id: 'agt_foreign', agent_name: agentName }],
    });

    // This tenant's agent names it anyway. A tenant-scoped read is all that stands between them,
    // and a computer it cannot see reads exactly like one that does not exist.
    const sessionId = `computer-turn-foreign-${newId()}`;
    const { stores, providerName } = await agentOnComputer({ computerId, agentName, sessionId, allowed: false });

    await expect(
      validateAgentSpec({
        spec: computerSpec({ providerName, computerId }),
        tenant_id: TENANT_ID,
        agent_id: 'agt_not_in_this_tenant',
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: stores.mcpServerStore,
        skillStore: stores.skillStore,
        sandboxProviderStore: stores.sandboxProviderStore,
        sandboxIntegration: computerIntegration(),
        logger,
      }),
    ).rejects.toThrow(/Unknown computer/);
    await expect(runTurn({ sessionId, stores })).rejects.toThrow(/Unknown computer/);
  });

  it('still starts when the machine is offline, and fails the command with the reason', async () => {
    const { computerId, client } = await onlineComputer(unique('offline-box'));
    const agentName = unique('offline-agent');
    const sessionId = `computer-turn-offline-${newId()}`;
    const { stores } = await agentOnComputer({ computerId, agentName, sessionId, allowed: true });
    client.close();
    await settle();

    // Offline is a turn-time reason, not a refusal: the turn runs and the command reports it.
    const finished = await runTurn({ sessionId, stores });
    expect(finished?.state.status).toBe('done');
  });

  it('carries a command whose output is megabytes, capped on the way into the turn', async () => {
    const name = unique('big-output-box');
    const { computerId, client } = await onlineComputer(name);
    // Two megabytes: the size the live test failed on, and twice what the turn may keep.
    const huge = 'x'.repeat(2 * 1024 * 1024);
    client.answerWith(frame =>
      frame['op'] === 'exec' ? { ...OK_EXEC, stdout: huge, bytes_total: huge.length } : undefined,
    );
    const agentName = unique('big-output-agent');
    const sessionId = `computer-turn-big-${newId()}`;
    const { stores } = await agentOnComputer({ computerId, agentName, sessionId, allowed: true });

    const finished = await runTurn({ sessionId, stores });

    // The frame crosses the socket and the relay RPC whole; what the turn keeps is far smaller,
    // which is what keeps the snapshot inside what D1 accepts for one value.
    expect(finished?.state.status).toBe('done');
    expect(JSON.stringify(finished?.snapshot.threads ?? {}).length).toBeLessThan(D1_MAX_VALUE_BYTES);
    client.close();
  }, 180_000);

  it('keeps the turn going when the relay is reset mid-command, and never re-runs it', async () => {
    const { computerId, client } = await onlineComputer(unique('reset-box'));
    const agentName = unique('reset-agent');
    const sessionId = `computer-turn-reset-${newId()}`;
    const { stores } = await agentOnComputer({ computerId, agentName, sessionId, allowed: true });
    const computers = workersComputersService(env);
    // Reset after the turn read the machine's hello, so the failure is a rejected command rather
    // than a computer that never said where its sessions live: a deploy against a live relay.
    const reset: ComputersService = {
      store: computers.store,
      rateLimiter: undefined,
      relayFetch: computers.relayFetch.bind(computers),
      relay: id => ({
        request: () => Promise.reject(new Error('Durable Object reset because its code was updated')),
        revoke: () => Promise.resolve({ closed: 0 }),
        disconnect: () => Promise.resolve({ closed: 0 }),
        destroy: () => Promise.resolve(),
        status: () => computers.relay(id).status(),
      }),
    };

    const finished = await runTurn({ sessionId, stores, computers: reset });

    // The turn keeps going and the model is told; nothing was sent twice, because nothing was retried.
    expect(finished?.state.status).toBe('done');
    expect(JSON.stringify(finished?.snapshot.threads ?? {})).toContain('connection to the computer was interrupted');
    expect(client.received.filter(frame => frame['op'] === 'exec')).toHaveLength(0);
    client.close();
  });
});

/** What sandbox init sends when a skill mounter is attached: the skill list, then the downloader. */
function skillInitFrames(client: FakeComputerClient) {
  return {
    uploads: client.received.filter(
      frame => frame['op'] === 'file_put' && String(frame['path']).endsWith('requested-skills.json'),
    ),
    downloaderExecs: client.received.filter(
      frame => frame['op'] === 'exec' && String(frame['command']).includes('skill_downloader.py'),
    ),
  };
}

async function gitSkill(stores: ReturnType<typeof d1Persistence>, name: string): Promise<string> {
  await stores.skillStore.createSkill({
    tenant_id: TENANT_ID,
    name,
    manifest: {
      type: 'git',
      name,
      url: 'https://example.test/skills.git',
      ref: 'main',
      description: 'a skill the machine would have to download',
    },
  });
  return name;
}

describe('a machine that cannot run the skill downloader', () => {
  it('still runs plain commands, with no downloader upload and no downloader exec', async () => {
    const { computerId, client } = await onlineComputer(unique('no-pydantic-box'), false);
    const sessionId = `computer-turn-no-skills-${newId()}`;
    const { stores } = await agentOnComputer({
      computerId,
      agentName: unique('no-skills-agent'),
      sessionId,
      allowed: true,
    });

    const finished = await runTurn({ sessionId, stores });
    expect(finished?.state.status).toBe('done');
    // The turn's own commands still reached the machine...
    expect(client.received.filter(frame => frame['op'] === 'exec').length).toBeGreaterThan(1);
    // ...and nothing about skills did, so `import pydantic` never had the chance to fail.
    const { uploads, downloaderExecs } = skillInitFrames(client);
    expect(uploads).toHaveLength(0);
    expect(downloaderExecs).toHaveLength(0);
    client.close();
  });

  it('refuses an agent that asks for a skill, at validation and at turn time', async () => {
    const { computerId, client } = await onlineComputer(unique('no-pydantic-refuse-box'), false);
    const sessionId = `computer-turn-skills-refused-${newId()}`;
    const skillName = await gitSkill(d1Persistence(), unique('needs-download'));
    const { stores, providerName, agent, computers } = await agentOnComputer({
      computerId,
      agentName: unique('skills-agent'),
      sessionId,
      allowed: true,
      skillName,
    });
    // Validation reads the row, which the relay writes once per connect. Nothing can be said
    // about the machine's skills before it has said anything at all.
    const readRow = () => computers.store.getComputer({ tenant_id: TENANT_ID, computer_id: computerId });
    let stored = await readRow();
    for (let attempt = 0; attempt < 100 && stored?.capabilities == null; attempt += 1) {
      await settle(2);
      stored = await readRow();
    }
    expect(stored?.capabilities).toEqual({ python3: true, git: true, skills: false });

    const expected = /cannot mount skills: it needs python3, git and the pydantic package/;
    await expect(
      validateAgentSpec({
        spec: computerSpec({ providerName, computerId, skillName }),
        tenant_id: TENANT_ID,
        agent_id: agent.id,
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: stores.mcpServerStore,
        skillStore: stores.skillStore,
        sandboxProviderStore: stores.sandboxProviderStore,
        sandboxIntegration: computerIntegration(),
        logger,
      }),
    ).rejects.toThrow(expected);
    await expect(runTurn({ sessionId, stores })).rejects.toThrow(expected);
    // A traceback out of sandbox init is exactly what this replaces, so nothing was sent.
    expect(skillInitFrames(client).downloaderExecs).toHaveLength(0);
    client.close();
  });

  it('leaves a machine that reports skills mounting them as before', async () => {
    const { computerId, client } = await onlineComputer(unique('pydantic-box'), true);
    // Init uploads the skill list before it runs the downloader, so this machine accepts files.
    client.answerWith(frame => (frame['op'] === 'exec' ? OK_EXEC : { bytes_written: 0, sha256: null }));
    const sessionId = `computer-turn-skills-ok-${newId()}`;
    const { stores } = await agentOnComputer({
      computerId,
      agentName: unique('skills-ok-agent'),
      sessionId,
      allowed: true,
    });

    await runTurn({ sessionId, stores });
    // No skills on the spec, but the mounter still runs so one the agent dropped is cleaned up.
    const { uploads, downloaderExecs } = skillInitFrames(client);
    expect(uploads).toHaveLength(1);
    expect(downloaderExecs).toHaveLength(1);
    client.close();
  });
});

describe('a grant belongs to an agent, not to a name', () => {
  it("does not pass to a new agent that takes the deleted one's name", async () => {
    const { computerId, client } = await onlineComputer(unique('reuse-box'));
    const stores = d1Persistence();
    const computers = workersComputersService(env);
    const providerName = await upsertMockProvider({ stores, scenario: 'sandbox' });
    const name = unique('reused-name');

    const granted = await stores.agentStore.createAgent({
      tenant_id: TENANT_ID,
      name,
      description: 'the one an admin meant',
      manifest: computerSpec({ providerName, computerId }),
      external_id: null,
      created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
    });
    await computers.store.putAgentAccess({
      tenant_id: TENANT_ID,
      computer_id: computerId,
      agents: [{ agent_id: granted.id, agent_name: granted.name }],
    });
    expect(
      await computers.store.isAgentAllowed({ tenant_id: TENANT_ID, computer_id: computerId, agent_id: granted.id }),
    ).toBe(true);

    // The owner deletes it. Anyone in the tenant may now create an agent, and nothing stops them
    // choosing the same name — which is exactly what a name-keyed grant would have handed over.
    await stores.agentStore.deleteAgent({ tenant_id: TENANT_ID, id: granted.id });
    await computers.store.deleteAgentAccessForAgent({ tenant_id: TENANT_ID, agent_id: granted.id });

    const impostor = await stores.agentStore.createAgent({
      tenant_id: TENANT_ID,
      name,
      description: 'somebody else, same name',
      manifest: computerSpec({ providerName, computerId }),
      external_id: null,
      created_by_subject: { subject_id: 'someone-else', subject_type: 'user', subject_display_name: 'someone else' },
    });
    expect(impostor.id).not.toBe(granted.id);
    expect(
      await computers.store.isAgentAllowed({ tenant_id: TENANT_ID, computer_id: computerId, agent_id: impostor.id }),
    ).toBe(false);

    // Refused when the spec is validated...
    await expect(
      validateAgentSpec({
        spec: computerSpec({ providerName, computerId }),
        tenant_id: TENANT_ID,
        agent_id: impostor.id,
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: stores.mcpServerStore,
        skillStore: stores.skillStore,
        sandboxProviderStore: stores.sandboxProviderStore,
        sandboxIntegration: computerIntegration(),
        logger,
      }),
    ).rejects.toThrow(/not allowed/);

    // ...and again when a session bound to it tries to run.
    const sessionId = `computer-turn-reuse-${newId()}`;
    await stores.sessionStore.createSession({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: { subject_id: 'someone-else', subject_type: 'user', subject_display_name: 'someone else' },
      agent: { type: 'reference', id: impostor.id, name: impostor.name },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    await expect(runTurn({ sessionId, stores })).rejects.toThrow(/not allowed/);
    expect(client.received.filter(frame => frame['op'] === 'exec')).toHaveLength(0);
    client.close();
  });

  it('refuses to grant a name no agent answers to', async () => {
    const computers = workersComputersService(env);
    const app = computersApp({ computers });
    const created = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: unique('grant-box') }),
      }),
      env,
    );
    const computerId = (await created.json<{ data: { computer: { id: string } } }>()).data.computer.id;

    const response = await app.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/v1/computers/${computerId}/agents`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_names: ['nobody-by-that-name'] }),
      }),
      env,
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: { message: 'No such agent: nobody-by-that-name' } });
    expect(await computers.store.listAgentAccess({ tenant_id: TENANT_ID, computer_id: computerId })).toEqual([]);
  });

  it('cannot be given to an agent while that agent is being created', async () => {
    const { computerId, client } = await onlineComputer(unique('create-box'));
    const stores = d1Persistence();
    const providerName = await upsertMockProvider({ stores, scenario: 'text' });
    // A new agent has no id, so nothing can already have granted it this machine. Naming one at
    // create time is refused; the agent is saved first and granted afterwards.
    await expect(
      validateAgentSpec({
        spec: computerSpec({ providerName, computerId }),
        tenant_id: TENANT_ID,
        agent_id: undefined,
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: stores.mcpServerStore,
        skillStore: stores.skillStore,
        sandboxProviderStore: stores.sandboxProviderStore,
        sandboxIntegration: computerIntegration(),
        logger,
      }),
    ).rejects.toThrow(/save the agent first/);
    client.close();
  });
});

describe('spec validation', () => {
  it('refuses an inline agent, an unknown computer, and an agent with no grant', async () => {
    const { computerId, client } = await onlineComputer(unique('validate-box'));
    const stores = d1Persistence();
    const computers = workersComputersService(env);
    const providerName = await upsertMockProvider({ stores, scenario: 'text' });
    const allowedAgent = await stores.agentStore.createAgent({
      tenant_id: TENANT_ID,
      name: unique('validate-allowed'),
      description: 'granted',
      manifest: computerSpec({ providerName, computerId }),
      external_id: null,
      created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
    });
    await computers.store.putAgentAccess({
      tenant_id: TENANT_ID,
      computer_id: computerId,
      agents: [{ agent_id: allowedAgent.id, agent_name: allowedAgent.name }],
    });

    const validate = (input: { agent_id: string | undefined; computer: string }) =>
      validateAgentSpec({
        spec: computerSpec({ providerName, computerId: input.computer }),
        tenant_id: TENANT_ID,
        agent_id: input.agent_id,
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: stores.mcpServerStore,
        skillStore: stores.skillStore,
        sandboxProviderStore: stores.sandboxProviderStore,
        sandboxIntegration: computerIntegration(),
        logger,
      });

    await expect(validate({ agent_id: undefined, computer: computerId })).rejects.toThrow(/save the agent first/);
    await expect(validate({ agent_id: 'agt_not_granted', computer: computerId })).rejects.toThrow(/not allowed/);
    await expect(validate({ agent_id: allowedAgent.id, computer: 'no-such-computer' })).rejects.toThrow(
      /Unknown computer/,
    );
    await expect(validate({ agent_id: allowedAgent.id, computer: computerId })).resolves.toBeUndefined();
    client.close();
  });
});
