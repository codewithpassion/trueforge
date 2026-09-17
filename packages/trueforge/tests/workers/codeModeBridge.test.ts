import type { IToolSet } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { CodeModeDispatcher } from '@truefoundry/trueforge-core/core/sandbox/codeMode/CodeModeDispatcher';
import { CodeModeReplySchema } from '@truefoundry/trueforge-core/core/sandbox/codeMode/types';
import { createConsoleLogger } from '../../src/workers/logger';
import { CloudflareComputerCodeModeTransport } from '../../src/workers/sandbox/CloudflareComputerCodeModeTransport';
import {
  CODE_MODE_BRIDGE_URL,
  CodeModeBridgeRegistry,
  type CodeModeDispatchOutcome,
} from '../../src/workers/sandbox/codeModeBridge';
import { COMPUTER_MCP_CLIENT_BIN, COMPUTER_MCP_CLIENT_PATH } from '../../src/workers/sandbox/computerPaths';

const logger = createConsoleLogger({ level: 'error', bindings: { component: 'code-mode-bridge-test' } });

function toolSet(listTools: IToolSet['listTools']): IToolSet {
  return {
    name: 'demo',
    id: 'demo',
    preload: true,
    hasPreloadedTools: true,
    listTools,
    callTool: () =>
      Promise.resolve({
        result: { content: [{ type: 'text' as const, text: 'ok' }], isError: false },
        wasInitialized: undefined,
      }),
    toolCallInfo: () =>
      Promise.resolve({
        type: 'mcp' as const,
        mcp_server_id: 'demo',
        mcp_server_name: 'demo',
        original_tool_name: 'ping',
      }),
  };
}

function pingToolSet(): IToolSet {
  return toolSet(() =>
    Promise.resolve({
      result: {
        tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' as const }, preload: true }],
      },
      wasInitialized: undefined,
    }),
  );
}

function dispatcherFor(servers: IToolSet[]): CodeModeDispatcher {
  return new CodeModeDispatcher({ toolSets: servers, logger });
}

function parseReply(outcome: CodeModeDispatchOutcome) {
  if (!outcome.ok) {
    throw new Error(`expected a reply, got status ${String(outcome.status)}: ${outcome.message}`);
  }
  return CodeModeReplySchema.parse(JSON.parse(outcome.replyJson));
}

function listToolsJson(server = 'demo'): string {
  return JSON.stringify({ op: 'list_tools', server });
}

describe('CodeModeBridgeRegistry', () => {
  it('answers a request that carries a token it opened', async () => {
    const registry = new CodeModeBridgeRegistry();
    const token = registry.open({ dispatcher: dispatcherFor([pingToolSet()]), timeoutMs: 5_000 });

    const reply = parseReply(await registry.dispatch({ token, requestJson: listToolsJson(), traceCarrier: {} }));

    expect(reply.ok).toBe(true);
    expect(reply).toMatchObject({ result: { tools: [{ name: 'ping' }] } });
  });

  it('refuses a token it never opened, with no reply envelope at all', async () => {
    const registry = new CodeModeBridgeRegistry();
    registry.open({ dispatcher: dispatcherFor([pingToolSet()]), timeoutMs: 5_000 });

    const outcome = await registry.dispatch({
      token: 'not-a-token',
      requestJson: listToolsJson(),
      traceCarrier: {},
    });

    expect(outcome).toEqual({ ok: false, status: 401, message: 'Code Mode token is not open for this session' });
  });

  it('refuses a token that was closed when its turn ended', async () => {
    const registry = new CodeModeBridgeRegistry();
    const token = registry.open({ dispatcher: dispatcherFor([pingToolSet()]), timeoutMs: 5_000 });
    registry.close(token);

    const outcome = await registry.dispatch({ token, requestJson: listToolsJson(), traceCarrier: {} });

    expect(outcome.ok).toBe(false);
  });

  it('blames the caller for a body that is not a Code Mode request', async () => {
    const registry = new CodeModeBridgeRegistry();
    const token = registry.open({ dispatcher: dispatcherFor([pingToolSet()]), timeoutMs: 5_000 });

    for (const requestJson of ['not json at all', '{"op":"drop_tables"}', '[]']) {
      const reply = parseReply(await registry.dispatch({ token, requestJson, traceCarrier: {} }));
      expect(reply).toEqual({ ok: false, error: 'Malformed Code Mode request', source: 'caller' });
    }
  });

  it('gives up on a tool that outlasts the command waiting for it', async () => {
    const registry = new CodeModeBridgeRegistry();
    const token = registry.open({
      dispatcher: dispatcherFor([toolSet(() => new Promise(() => undefined))]),
      timeoutMs: 50,
    });

    const reply = parseReply(await registry.dispatch({ token, requestJson: listToolsJson(), traceCarrier: {} }));

    expect(reply).toMatchObject({ ok: false, source: 'transport' });
    expect(reply.ok === false && reply.error).toContain('Code Mode dispatch gave up');
  });

  it('names an MCP server the agent does not have as a caller fault', async () => {
    const registry = new CodeModeBridgeRegistry();
    const token = registry.open({ dispatcher: dispatcherFor([pingToolSet()]), timeoutMs: 5_000 });

    const reply = parseReply(await registry.dispatch({ token, requestJson: listToolsJson('other'), traceCarrier: {} }));

    expect(reply).toMatchObject({ ok: false, source: 'caller' });
  });
});

describe('CloudflareComputerCodeModeTransport', () => {
  function transport(maxRequestTimeoutSeconds: number, registry = new CodeModeBridgeRegistry()) {
    return { registry, transport: new CloudflareComputerCodeModeTransport({ registry, maxRequestTimeoutSeconds }) };
  }

  function start(built: ReturnType<typeof transport>, requestTimeoutSeconds: number) {
    return built.transport.start({
      codeModeDispatcher: dispatcherFor([pingToolSet()]),
      sandboxId: 'tenant-1:session-1',
      requestTimeoutSeconds,
    });
  }

  it('installs the client on the workspace and links the CLI onto PATH', () => {
    const install = transport(300).transport.getClientInstall();

    expect(install.remotePath).toBe(COMPUTER_MCP_CLIENT_PATH);
    expect(install.pathBinSymlink).toBe(COMPUTER_MCP_CLIENT_BIN);
    expect(install.content).toContain('TFY_CM_HTTP_URL');
  });

  it('hands the sandbox the bridge address and a token that works', async () => {
    const built = transport(300);
    const { env } = await start(built, 90);

    expect(env['TFY_CM_HTTP_URL']).toBe(CODE_MODE_BRIDGE_URL);
    expect(env['TFY_CM_REQUEST_TIMEOUT_SECONDS']).toBe('90');
    const token = env['TFY_CM_HTTP_TOKEN'] ?? '';
    const reply = parseReply(await built.registry.dispatch({ token, requestJson: listToolsJson(), traceCarrier: {} }));
    expect(reply.ok).toBe(true);
  });

  it('never lets the client wait longer than the command that asked', async () => {
    const { env } = await start(transport(30), 90);

    expect(env['TFY_CM_REQUEST_TIMEOUT_SECONDS']).toBe('30');
  });

  it('keeps one token across repeated starts and drops it on stop', async () => {
    const built = transport(300);
    const first = await start(built, 60);
    const second = await start(built, 60);
    expect(second.env['TFY_CM_HTTP_TOKEN']).toBe(first.env['TFY_CM_HTTP_TOKEN']);

    await built.transport.stop();

    const outcome = await built.registry.dispatch({
      token: first.env['TFY_CM_HTTP_TOKEN'] ?? '',
      requestJson: listToolsJson(),
      traceCarrier: {},
    });
    expect(outcome).toMatchObject({ ok: false, status: 401 });
  });
});
