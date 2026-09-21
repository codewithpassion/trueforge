/**
 * A whole turn on a machine the tenant enrolled: a saved agent with `sandbox.computer_id` runs its
 * command through the fake client, and the allowlist is enforced again when the turn starts.
 */
import { AgentSpecSchema, Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { env } from 'cloudflare:workers';
import { computerSessionDirectory } from '../../src/computers/service';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { validateAgentSpec } from '../../src/runtime/sessionResources';
import { startTurnInProcess } from '../../src/runtime/turnRunner';
import { newId } from '../../src/utils/id';
import { workersComputersService } from '../../src/workers/computersService';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersSandboxIntegration } from '../../src/workers/sandbox/workersSandboxIntegration';
import { d1Persistence, migrateDatabase, TENANT_ID, upsertMockProvider, USER_REF } from './harness';
import { computersApp, FakeComputerClient, PUBLIC_BASE_URL, settle } from './remoteComputerClient';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'computer-turn-test' } });

const OK_EXEC = { exit_code: 0, stdout: '', stderr: '', bytes_total: 0, truncated: false, duration_ms: 1 };
/** Distinctive enough that finding it in the turn proves it came off the machine. */
const UNAME_OUTPUT = 'Linux office-box 6.1.0 #1 SMP x86_64 GNU/Linux\n';

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

/** Creates a computer through the API, enrolls it, and connects a client that answers commands. */
async function onlineComputer(name: string): Promise<{ computerId: string; client: FakeComputerClient }> {
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
      onRequest: frame =>
        frame['op'] === 'exec'
          ? { ...OK_EXEC, stdout: String(frame['command']).includes('uname') ? UNAME_OUTPUT : '' }
          : undefined,
    },
  });
  // The hello write is what turns the row online and gives the provider a home to build paths from.
  await settle();
  return { computerId: body.data.computer.id, client };
}

function computerSpec({ providerName, computerId }: { providerName: string; computerId: string }) {
  return AgentSpecSchema.parse({
    model: { name: `${providerName}/mock-model` },
    instructions: 'test',
    config: { sandbox: { enabled: true, file_downloads: false, computer_id: computerId } },
  });
}

async function runTurn({ sessionId, stores }: { sessionId: string; stores: ReturnType<typeof d1Persistence> }) {
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
      sandboxIntegration: computerIntegration(),
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
}: {
  computerId: string;
  agentName: string;
  sessionId: string;
  allowed: boolean;
}) {
  const stores = d1Persistence();
  const computers = workersComputersService(env);
  const providerName = await upsertMockProvider({ stores, scenario: 'sandbox' });
  const agent = await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: agentName,
    description: 'runs on a machine',
    manifest: computerSpec({ providerName, computerId }),
    external_id: null,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
  });
  await computers.store.putAgentAccess({
    tenant_id: TENANT_ID,
    computer_id: computerId,
    agent_names: allowed ? [agentName] : [],
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
  return { stores, providerName, computers };
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

    // The model's sandbox command reached the machine over the wire, in this session's directory.
    const execFrames = client.received.filter(frame => frame['op'] === 'exec');
    expect(execFrames.length).toBeGreaterThan(0);
    const expectedCwd = computerSessionDirectory({ home: '/home/trueforge', sessionId });
    expect(execFrames.some(frame => frame['cwd'] === expectedCwd)).toBe(true);

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

  it('refuses a computer that belongs to another tenant at turn time', async () => {
    const { computerId, client } = await onlineComputer(unique('other-tenant-box'));
    const agentName = unique('other-tenant-agent');
    const sessionId = `computer-turn-tenant-${newId()}`;
    const { stores, computers } = await agentOnComputer({ computerId, agentName, sessionId, allowed: true });
    // Move the machine out of this tenant's reach; the session's spec still names it.
    await computers.store.revokeComputer({ tenant_id: TENANT_ID, computer_id: computerId });

    await expect(runTurn({ sessionId, stores })).rejects.toThrow(/revoked/);
    client.close();
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
});

describe('spec validation', () => {
  it('refuses an inline agent, an unknown computer, and an agent with no grant', async () => {
    const { computerId, client } = await onlineComputer(unique('validate-box'));
    const stores = d1Persistence();
    const computers = workersComputersService(env);
    const providerName = await upsertMockProvider({ stores, scenario: 'text' });
    const allowedAgent = unique('validate-allowed');
    await computers.store.putAgentAccess({
      tenant_id: TENANT_ID,
      computer_id: computerId,
      agent_names: [allowedAgent],
    });

    const validate = (input: { agent_name: string | undefined; computer: string }) =>
      validateAgentSpec({
        spec: computerSpec({ providerName, computerId: input.computer }),
        tenant_id: TENANT_ID,
        agent_name: input.agent_name,
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: stores.mcpServerStore,
        skillStore: stores.skillStore,
        sandboxProviderStore: stores.sandboxProviderStore,
        sandboxIntegration: computerIntegration(),
        logger,
      });

    await expect(validate({ agent_name: undefined, computer: computerId })).rejects.toThrow(/Only a saved agent/);
    await expect(validate({ agent_name: 'not-granted', computer: computerId })).rejects.toThrow(/not allowed/);
    await expect(validate({ agent_name: allowedAgent, computer: 'no-such-computer' })).rejects.toThrow(
      /Unknown computer/,
    );
    await expect(validate({ agent_name: allowedAgent, computer: computerId })).resolves.toBeUndefined();
    client.close();
  });
});
