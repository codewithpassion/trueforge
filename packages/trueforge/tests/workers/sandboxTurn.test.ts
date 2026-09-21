import { AgentSpecSchema, Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { env } from 'cloudflare:workers';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { validateAgentSpec } from '../../src/runtime/sessionResources';
import { startTurnInProcess } from '../../src/runtime/turnRunner';
import { SANDBOX_READY_STATUS } from '../../src/schemas/sandboxProvider';
import { newId } from '../../src/utils/id';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersSandboxIntegration } from '../../src/workers/sandbox/workersSandboxIntegration';
import { d1Persistence, migrateDatabase, TENANT_ID, upsertMockProvider, USER_REF } from './harness';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'sandbox-turn-test' } });

/** The sandbox backend the deploy would set; the test wrangler config leaves the var unset. */
function sandboxIntegration() {
  return createWorkersSandboxIntegration({
    backend: 'cloudflare-computer',
    namespace: env.COMPUTER_DO,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 1024,
  });
}

/** The agent spec a sandbox session runs; the create gate validates the same shape. */
function sandboxSpec(providerName: string) {
  return AgentSpecSchema.parse({
    model: { name: `${providerName}/mock-model` },
    instructions: 'test',
    config: { sandbox: { enabled: true, file_downloads: false } },
    mcp_servers: [{ name: 'context7' }],
  });
}

/** Turning the built-in sandbox on from Settings stores this record. */
async function enableBuiltInSandbox(): Promise<void> {
  await d1Persistence().sandboxProviderStore.upsertSandboxProvider({
    tenant_id: TENANT_ID,
    manifest: { type: 'cloudflare-computer' },
    ...SANDBOX_READY_STATUS,
  });
}

/** A session whose agent has a sandbox and one deferred MCP server, which is what crashed in review. */
async function createSandboxSession(sessionId: string) {
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: 'text' });
  await stores.mcpServerStore.upsertServer({
    tenant_id: TENANT_ID,
    name: 'context7',
    manifest: {
      type: 'remote',
      name: 'context7',
      url: 'https://mcp.context7.test/mcp',
      description: 'Docs lookup.',
      auth: { type: 'header', headers: { authorization: 'Bearer mcp-test' } },
    },
  });
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: sessionId,
    created_by_subject: { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF },
    agent: { type: 'inline', spec: sandboxSpec(providerName) },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  return { stores, providerName };
}

describe('a turn with the sandbox enabled and an MCP server', () => {
  beforeAll(async () => {
    await migrateDatabase();
  });

  // The deploy var alone is not enough: nothing runs until the tenant enables it in Settings.
  it('refuses the sandbox agent before the built-in provider is enabled, and accepts it after', async () => {
    const { stores, providerName } = await createSandboxSession(`sandbox-gate-${newId()}`);
    await stores.sandboxProviderStore.deleteSandboxProvider(TENANT_ID);
    const validate = () =>
      validateAgentSpec({
        spec: sandboxSpec(providerName),
        tenant_id: TENANT_ID,
        modelProviderStore: stores.modelProviderStore,
        mcpServerStore: stores.mcpServerStore,
        skillStore: stores.skillStore,
        sandboxProviderStore: stores.sandboxProviderStore,
        sandboxIntegration: sandboxIntegration(),
        logger,
      });

    await expect(validate()).rejects.toThrow(/no sandbox provider is configured/);
    await enableBuiltInSandbox();
    await expect(validate()).resolves.toBeUndefined();
  });

  it('builds and runs instead of failing on a Code Mode transport the provider cannot make', async () => {
    const sessionId = `sandbox-mcp-${newId()}`;
    const { stores } = await createSandboxSession(sessionId);
    await enableBuiltInSandbox();
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
        sandboxIntegration: sandboxIntegration(),
        onTurnDrained: undefined,
      },
    });

    await started.drained;

    const finished = await stores.sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.record.turn_id });
    // The old failure was a thrown `createCodeModeTransport`, which ended the turn as `error`.
    expect(finished?.state.status).toBe('done');
  });
});
