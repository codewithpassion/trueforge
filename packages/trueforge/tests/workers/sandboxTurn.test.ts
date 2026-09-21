import { AgentSpecSchema, Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { CodeModeReplySchema } from '@truefoundry/trueforge-core/core/sandbox/codeMode/types';
import { env } from 'cloudflare:workers';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { validateAgentSpec } from '../../src/runtime/sessionResources';
import { startTurnInProcess } from '../../src/runtime/turnRunner';
import { SANDBOX_READY_STATUS } from '../../src/schemas/sandboxProvider';
import { newId } from '../../src/utils/id';
import { createConsoleLogger } from '../../src/workers/logger';
import { CODE_MODE_BRIDGE_URL, CodeModeBridgeRegistry } from '../../src/workers/sandbox/codeModeBridge';
import type { ComputerExecOutcome, ComputerExecRequest, ComputerWorkspace } from '../../src/workers/sandbox/ComputerDO';
import { createWorkersSandboxIntegration } from '../../src/workers/sandbox/workersSandboxIntegration';
import { d1Persistence, FakeComputer, migrateDatabase, TENANT_ID, upsertMockProvider, USER_REF } from './harness';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'sandbox-turn-test' } });

/**
 * Stands in for the container and does what it would do: while the command runs, it presents the
 * token it was handed on the bridge. A turn's channel is closed when the turn ends, so this is the
 * only moment the token is good for anything.
 */
class CodeModeProbeComputer extends FakeComputer {
  readonly replies: { server: string; reply: unknown }[] = [];

  constructor(private readonly registry: CodeModeBridgeRegistry) {
    super();
  }

  override async execCommand(request: ComputerExecRequest): Promise<ComputerExecOutcome> {
    const outcome = await super.execCommand(request);
    const token = request.env['TFY_CM_HTTP_TOKEN'];
    if (token !== undefined) {
      for (const server of ['context7', 'some-other-agents-server']) {
        const dispatched = await this.registry.dispatch({
          token,
          requestJson: JSON.stringify({ op: 'list_tools', server }),
          traceCarrier: {},
        });
        this.replies.push({
          server,
          reply: dispatched.ok ? CodeModeReplySchema.parse(JSON.parse(dispatched.replyJson)) : dispatched,
        });
      }
    }
    return outcome;
  }
}

/** The sandbox backend the deploy would set; the test wrangler config leaves the var unset. */
function sandboxIntegration(options?: {
  codeModeRegistry?: CodeModeBridgeRegistry | undefined;
  computer?: ComputerWorkspace | undefined;
}) {
  const computer = options?.computer;
  return createWorkersSandboxIntegration({
    backend: 'cloudflare-computer',
    computers: undefined,
    namespace:
      computer === undefined
        ? env.COMPUTER_DO
        : { idFromName: name => env.COMPUTER_DO.idFromName(name), get: () => computer },
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 1024,
    codeModeRegistry: options?.codeModeRegistry,
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
async function createSandboxSession(params: { sessionId: string; scenario: string }) {
  const { sessionId } = params;
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: params.scenario });
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

async function runSandboxTurn(params: {
  sessionId: string;
  scenario: string;
  sandboxIntegration: ReturnType<typeof sandboxIntegration>;
  /** Whether the tenant has turned the built-in provider on in Settings. */
  enabled: boolean;
}) {
  const { stores } = await createSandboxSession({ sessionId: params.sessionId, scenario: params.scenario });
  if (params.enabled) {
    await enableBuiltInSandbox();
  } else {
    await stores.sandboxProviderStore.deleteSandboxProvider(TENANT_ID);
  }
  const session = await new Sessions({ sessionStore: stores.sessionStore }).get({
    tenant_id: TENANT_ID,
    session_id: params.sessionId,
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
      sandboxIntegration: params.sandboxIntegration,
      onTurnDrained: undefined,
    },
  });
  await started.drained;

  return stores.sessionStore.getTurn({ session_id: params.sessionId, turn_id: started.turn.record.turn_id });
}

describe('a turn with the sandbox enabled and an MCP server', () => {
  beforeAll(async () => {
    await migrateDatabase();
  });

  // The deploy var alone is not enough: nothing runs until the tenant enables it in Settings.
  it('refuses the sandbox agent before the built-in provider is enabled, and accepts it after', async () => {
    const { stores, providerName } = await createSandboxSession({
      sessionId: `sandbox-gate-${newId()}`,
      scenario: 'text',
    });
    await stores.sandboxProviderStore.deleteSandboxProvider(TENANT_ID);
    const validate = () =>
      validateAgentSpec({
        spec: sandboxSpec(providerName),
        tenant_id: TENANT_ID,
        agent_name: undefined,
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

  it('runs on a runtime that serves no Code Mode bridge, with the MCP tools called directly', async () => {
    const finished = await runSandboxTurn({
      sessionId: `sandbox-mcp-${newId()}`,
      scenario: 'text',
      enabled: true,
      sandboxIntegration: sandboxIntegration(),
    });

    // The old failure was a thrown `createCodeModeTransport`, which ended the turn as `error`.
    expect(finished?.state.status).toBe('done');
  });

  it('opens a Code Mode channel for the turn and answers the agent MCP servers on it', async () => {
    const codeModeRegistry = new CodeModeBridgeRegistry();
    const computer = new CodeModeProbeComputer(codeModeRegistry);

    const finished = await runSandboxTurn({
      sessionId: `sandbox-code-mode-${newId()}`,
      // The model asks for one sandbox command, which is where a turn gets its Code Mode channel.
      scenario: 'sandbox',
      enabled: true,
      sandboxIntegration: sandboxIntegration({ codeModeRegistry, computer }),
    });
    expect(finished?.state.status).toBe('done');

    const withBridge = computer.execCalls.filter(call => call.env['TFY_CM_HTTP_TOKEN'] !== undefined);
    expect(withBridge).not.toHaveLength(0);
    expect(withBridge[0]?.env['TFY_CM_HTTP_URL']).toBe(CODE_MODE_BRIDGE_URL);

    // The MCP server itself is unreachable in these tests; what matters is that the dispatcher holds
    // this turn's servers, so `context7` is not reported as one the agent does not have.
    expect(computer.replies).toContainEqual({
      server: 'context7',
      reply: expect.not.objectContaining({ error: expect.stringContaining('is not available for this agent') }),
    });
    expect(computer.replies).toContainEqual({
      server: 'some-other-agents-server',
      reply: expect.objectContaining({
        ok: false,
        source: 'caller',
        error: expect.stringContaining('is not available for this agent'),
      }),
    });
  });

  it('closes the channel when the turn ends, so the token stops working', async () => {
    const codeModeRegistry = new CodeModeBridgeRegistry();
    const computer = new CodeModeProbeComputer(codeModeRegistry);

    await runSandboxTurn({
      sessionId: `sandbox-code-mode-closed-${newId()}`,
      scenario: 'sandbox',
      enabled: true,
      sandboxIntegration: sandboxIntegration({ codeModeRegistry, computer }),
    });

    const token = computer.execCalls.map(call => call.env['TFY_CM_HTTP_TOKEN']).find(value => value !== undefined);
    const afterTurn = await codeModeRegistry.dispatch({
      token: token ?? '',
      requestJson: JSON.stringify({ op: 'list_tools', server: 'context7' }),
      traceCarrier: {},
    });

    expect(afterTurn).toMatchObject({ ok: false, status: 401 });
  });

  // Code Mode rides on the provider, so a runtime that serves the bridge still offers none until
  // the tenant enables the built-in sandbox.
  it('opens no Code Mode channel while the built-in provider is disabled', async () => {
    const codeModeRegistry = new CodeModeBridgeRegistry();
    const computer = new CodeModeProbeComputer(codeModeRegistry);

    await expect(
      runSandboxTurn({
        sessionId: `sandbox-code-mode-disabled-${newId()}`,
        scenario: 'sandbox',
        enabled: false,
        sandboxIntegration: sandboxIntegration({ codeModeRegistry, computer }),
      }),
    ).rejects.toThrow(/no sandbox provider configured/);
    expect(computer.execCalls).toHaveLength(0);
    expect(computer.replies).toHaveLength(0);
  });
});
