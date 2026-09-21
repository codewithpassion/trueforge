import type { IToolSet } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { CodeModeDispatcher } from '@truefoundry/trueforge-core/core/sandbox/codeMode/CodeModeDispatcher';
import { CodeModeReplySchema } from '@truefoundry/trueforge-core/core/sandbox/codeMode/types';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import configuration from '../../src/config';
import { SANDBOX_READY_STATUS } from '../../src/schemas/sandboxProvider';
import { createConsoleLogger } from '../../src/workers/logger';
import { CODE_MODE_BRIDGE_URL } from '../../src/workers/sandbox/codeModeBridge';
import { sessionDurableObjectName } from '../../src/workers/sessionScope';
import { d1Persistence, migrateDatabase, TENANT_ID } from './harness';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'code-mode-routing-test' } });

/** Names of the tools the fake server actually ran, so a refusal can be told apart from a failure. */
const calledTools: string[] = [];

const demoToolSet: IToolSet = {
  name: 'demo',
  id: 'demo',
  preload: true,
  hasPreloadedTools: true,
  listTools: () =>
    Promise.resolve({
      result: {
        tools: [
          { name: 'ping', inputSchema: { type: 'object' as const }, preload: true },
          { name: 'secret', inputSchema: { type: 'object' as const }, preload: true },
          {
            name: 'wipe',
            inputSchema: { type: 'object' as const },
            preload: true,
            annotations: { destructiveHint: true },
          },
        ],
      },
      wasInitialized: undefined,
    }),
  // `secret` is listed by the server but not enabled for the agent.
  getAllowedToolNamesForSandbox: () => ['ping', 'wipe'],
  callTool: params => {
    calledTools.push(params.name);
    return Promise.resolve({
      result: { content: [{ type: 'text' as const, text: 'pong' }], isError: false },
      wasInitialized: undefined,
    });
  },
  toolCallInfo: () =>
    Promise.resolve({
      type: 'mcp' as const,
      mcp_server_id: 'demo',
      mcp_server_name: 'demo',
      original_tool_name: 'ping',
    }),
};

/**
 * Opens a Code Mode channel the way a turn does: through the provider the real `SessionDO` hands
 * out, so the token lands in that object's own bridge.
 */
async function openChannelInSession(session_id: string): Promise<string> {
  const name = sessionDurableObjectName({ tenant_id: TENANT_ID, session_id });
  return runInDurableObject(env.SESSION_DO.get(env.SESSION_DO.idFromName(name)), async instance => {
    const provider = await instance.sandboxIntegration.resolveProvider({
      tenant_id: TENANT_ID,
      store: d1Persistence().sandboxProviderStore,
      logger,
      sessionId: session_id,
      computer_id: undefined,
      turn_id: null,
    });
    if (provider === undefined) {
      throw new Error('expected the built-in provider once the tenant enabled it');
    }
    expect(provider.supportsCodeMode).toBe(true);
    const { env: channelEnv } = await provider.createCodeModeTransport().start({
      codeModeDispatcher: new CodeModeDispatcher({ toolSets: [demoToolSet], logger }),
      sandboxId: name,
      requestTimeoutSeconds: 30,
    });
    const token = channelEnv['TFY_CM_HTTP_TOKEN'];
    if (token === undefined) {
      throw new Error('expected the transport to hand the sandbox a token');
    }
    return token;
  });
}

/** Presents a token on the gateway the session's own `ComputerDO` built, as its container would. */
function presentThroughWorkspaceOf(params: { session_id: string; token: string; request?: object }) {
  const name = sessionDurableObjectName({ tenant_id: TENANT_ID, session_id: params.session_id });
  return runInDurableObject(env.COMPUTER_DO.get(env.COMPUTER_DO.idFromName(name)), async instance => {
    const response = await instance.egressGateway.fetch(
      new Request(CODE_MODE_BRIDGE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${params.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(params.request ?? { op: 'list_tools', server: 'demo' }),
      }),
    );
    return { status: response.status, body: await response.text() };
  });
}

describe('Code Mode routing through the objects the deploy wires together', () => {
  beforeAll(async () => {
    await migrateDatabase();
    await d1Persistence().sandboxProviderStore.upsertSandboxProvider({
      tenant_id: TENANT_ID,
      manifest: { type: 'cloudflare-computer' },
      ...SANDBOX_READY_STATUS,
    });
  });

  it('runs with the sandbox backend available, as the deploy does', () => {
    expect(configuration.TRUEFORGE_SANDBOX_BACKEND).toBe('cloudflare-computer');
  });

  it('answers a turn token presented through its own workspace gateway', async () => {
    const token = await openChannelInSession('routing-own');

    const answered = await presentThroughWorkspaceOf({ session_id: 'routing-own', token });

    expect(answered.status).toBe(200);
    const reply = CodeModeReplySchema.parse(JSON.parse(answered.body));
    expect(reply).toMatchObject({
      ok: true,
      result: { tools: [{ name: 'ping' }, { name: 'secret' }, { name: 'wipe' }] },
    });
  });

  it('refuses a live token of one session presented through another session workspace', async () => {
    const token = await openChannelInSession('routing-victim');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const answered = await presentThroughWorkspaceOf({ session_id: 'routing-attacker', token });

      expect(answered.status).toBe(401);
      // The same token still works where it belongs, so the refusal was about routing.
      await expect(presentThroughWorkspaceOf({ session_id: 'routing-victim', token })).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      warned.mockRestore();
    }
  });

  // The token sits in the sandbox env, so a raw request can skip the client and its approval check.
  it('refuses a destructive tool sent straight to the gateway, without running it', async () => {
    const token = await openChannelInSession('routing-destructive');

    const answered = await presentThroughWorkspaceOf({
      session_id: 'routing-destructive',
      token,
      request: { op: 'call_tool', server: 'demo', tool: 'wipe', arguments: {} },
    });

    expect(answered.status).toBe(200);
    expect(CodeModeReplySchema.parse(JSON.parse(answered.body))).toMatchObject({
      ok: false,
      source: 'caller',
      error: expect.stringContaining('is destructive'),
    });
    expect(calledTools).not.toContain('wipe');
  });

  it('refuses a tool the agent did not enable, sent straight to the gateway, without running it', async () => {
    const token = await openChannelInSession('routing-not-enabled');

    const answered = await presentThroughWorkspaceOf({
      session_id: 'routing-not-enabled',
      token,
      request: { op: 'call_tool', server: 'demo', tool: 'secret', arguments: {} },
    });

    expect(answered.status).toBe(200);
    expect(CodeModeReplySchema.parse(JSON.parse(answered.body))).toMatchObject({
      ok: false,
      source: 'caller',
      error: expect.stringContaining("tool 'secret' is not enabled"),
    });
    expect(calledTools).not.toContain('secret');
  });
});
