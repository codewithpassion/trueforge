import { AgentSpecSchema, Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { env } from 'cloudflare:workers';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { startTurnInProcess } from '../../src/runtime/turnRunner';
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
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({
        model: { name: `${providerName}/mock-model` },
        instructions: 'test',
        config: { sandbox: { enabled: true, file_downloads: false } },
        mcp_servers: [{ name: 'context7' }],
      }),
    },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  return stores;
}

describe('a turn with the sandbox enabled and an MCP server', () => {
  beforeAll(async () => {
    await migrateDatabase();
  });

  it('builds and runs instead of failing on a Code Mode transport the provider cannot make', async () => {
    const sessionId = `sandbox-mcp-${newId()}`;
    const stores = await createSandboxSession(sessionId);
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
