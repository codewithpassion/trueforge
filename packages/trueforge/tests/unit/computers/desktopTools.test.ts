import { isCallToolResponseResult, type CallToolResponse } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import type { ToolDefinition } from '@truefoundry/trueforge-core/core/mcp/LocalToolMCP';
import { createLogger } from 'winston';
import { desktopProviderTools } from '../../../src/computers/desktopTools';
import {
  ClientOpRequestSchema,
  type ComputerCapabilities,
  type RelayRequestInput,
  type RequestOutcome,
} from '../../../src/computers/protocol';
import { RemoteComputerProvider } from '../../../src/computers/RemoteComputerProvider';

const SESSION_ID = 'session-1';
const SCREENSHOT = { data_b64: '/9j/4AAQ', width: 1280, height: 800, media_type: 'image/jpeg' };
const DESKTOP: ComputerCapabilities = {
  python3: true,
  git: true,
  skills: false,
  desktop: true,
  desktop_unavailable_reason: null,
};

function ok(result: Record<string, unknown>): RequestOutcome {
  return { ok: true, result_json: JSON.stringify(result), waited_ms: 1 };
}

function refused(reason: 'human_in_control' | 'desktop_busy' | 'bad_request', message: string): RequestOutcome {
  return { ok: false, reason, message, last_seen_at: null, waited_ms: 1 };
}

/** A relay that answers every desktop op, unless the test hands it a refusal for one op. */
function providerWith({
  capabilities = DESKTOP,
  requireApproval = false,
  refuse = {},
}: {
  capabilities?: ComputerCapabilities;
  requireApproval?: boolean;
  refuse?: Partial<Record<string, RequestOutcome>>;
}) {
  const sent: RelayRequestInput[] = [];
  const provider = new RemoteComputerProvider({
    relay: {
      request: input => {
        sent.push(input);
        const op = ClientOpRequestSchema.parse(JSON.parse(input.op_json)).op;
        const refusal = refuse[op];
        if (refusal !== undefined) {
          return Promise.resolve(refusal);
        }
        return Promise.resolve(
          op === 'desktop_screenshot'
            ? ok(SCREENSHOT)
            : op === 'desktop_clipboard_get'
              ? ok({ text: 'copied text' })
              : ok({ ok: true }),
        );
      },
      releaseLease: () => Promise.resolve({ released: false }),
      revoke: () => Promise.reject(new Error('not used')),
      disconnect: () => Promise.reject(new Error('not used')),
      destroy: () => Promise.reject(new Error('not used')),
      status: () => Promise.reject(new Error('not used')),
    },
    computerId: 'cmp_1',
    computerName: 'office-box',
    tenantId: 'default',
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    workdir: '/var/lib/x/sessions',
    capabilities,
    requireApproval,
    defaultExecTimeoutSeconds: 10,
    fileMaxBytesForDownload: 1024,
    store: { appendAudit: () => Promise.resolve() },
    logger: createLogger({ silent: true }),
  });
  return { provider, sent };
}

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find(candidate => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return found;
}

function text(response: CallToolResponse): { text: string; isError: boolean } {
  if (!isCallToolResponseResult(response)) {
    throw new Error('expected a tool result');
  }
  const first = response.result.content[0];
  return { text: first?.type === 'text' ? first.text : '', isError: response.result.isError === true };
}

function sentOps(sent: readonly RelayRequestInput[]) {
  return sent.map(input => ClientOpRequestSchema.parse(JSON.parse(input.op_json)));
}

describe('desktop tools', () => {
  it('offers every computer tool on a desktop that needs no approval', () => {
    const { provider } = providerWith({});
    expect(
      desktopProviderTools(provider)
        .tools.map(candidate => candidate.name)
        .sort(),
    ).toEqual(
      [
        'computer_click',
        'computer_clipboard_read',
        'computer_clipboard_write',
        'computer_drag',
        'computer_key',
        'computer_screenshot',
        'computer_scroll',
        'computer_type',
      ].sort(),
    );
  });

  it('offers only the read tools when the computer asks for approval, and says why', () => {
    const { provider } = providerWith({ requireApproval: true });
    const offered = desktopProviderTools(provider);
    expect(offered.tools.map(candidate => candidate.name).sort()).toEqual([
      'computer_clipboard_read',
      'computer_screenshot',
    ]);
    expect(offered.instructions).toContain('approve each action');
  });

  it('offers nothing on a machine whose desktop is down, and tells the model why', () => {
    const { provider } = providerWith({
      capabilities: { ...DESKTOP, desktop: false, desktop_unavailable_reason: 'xdotool is missing' },
    });
    const offered = desktopProviderTools(provider);
    expect(offered.tools).toEqual([]);
    expect(offered.instructions).toContain('xdotool is missing');
  });

  it('clicks, waits, then screenshots, as the session, returning the stub', async () => {
    const { provider, sent } = providerWith({});
    const response = await tool(desktopProviderTools(provider).tools, 'computer_click').execute({ x: 100, y: 200 });

    expect(text(response)).toEqual({
      text: '[screenshot 1280x800 captured; image delivery arrives in Phase 9a-2]',
      isError: false,
    });
    expect(sentOps(sent)).toEqual([
      { op: 'desktop_input', actions: [{ type: 'click', x: 100, y: 200, button: 'left', count: 1 }] },
      { op: 'desktop_screenshot', quality: null },
    ]);
    expect(sent.every(input => input.principal.kind === 'agent' && input.principal.session_id === SESSION_ID)).toBe(
      true,
    );
    expect(sent.map(input => input.timeout_ms)).toEqual([2000, 5000]);
  });

  it('drags as move, press, move, release in one input', async () => {
    const { provider, sent } = providerWith({});
    await tool(desktopProviderTools(provider).tools, 'computer_drag').execute({
      from: { x: 1, y: 2 },
      to: { x: 30, y: 40 },
    });
    expect(sentOps(sent)[0]).toEqual({
      op: 'desktop_input',
      actions: [
        { type: 'mouse_move', x: 1, y: 2 },
        { type: 'mouse_down', button: 'left' },
        { type: 'mouse_move', x: 30, y: 40 },
        { type: 'mouse_up', button: 'left' },
      ],
    });
  });

  it('gives typing time for every character', async () => {
    const { provider, sent } = providerWith({});
    await tool(desktopProviderTools(provider).tools, 'computer_type').execute({ text: 'x'.repeat(512) });
    expect(sent[0]?.timeout_ms).toBe(2000 + 5 * 512);
  });

  it('reads the clipboard as text and writes both selections', async () => {
    const { provider, sent } = providerWith({});
    const { tools } = desktopProviderTools(provider);
    expect(text(await tool(tools, 'computer_clipboard_read').execute({}))).toEqual({
      text: 'copied text',
      isError: false,
    });
    await tool(tools, 'computer_clipboard_write').execute({ text: 'hello' });
    expect(sentOps(sent)[1]).toEqual({
      op: 'desktop_clipboard_set',
      text: 'hello',
      selections: ['clipboard', 'primary'],
    });
  });

  it('tells the model to hand over and stop when a person is in control', async () => {
    const { provider } = providerWith({ refuse: { desktop_screenshot: refused('human_in_control', 'paused') } });
    const result = text(await tool(desktopProviderTools(provider).tools, 'computer_screenshot').execute({}));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('request_human_takeover');
    expect(result.text).toContain('Do not retry');
  });

  it('does not screenshot after an action a person interrupted', async () => {
    const { provider, sent } = providerWith({ refuse: { desktop_input: refused('human_in_control', 'paused') } });
    const result = text(await tool(desktopProviderTools(provider).tools, 'computer_key').execute({ keys: 'Return' }));
    expect(result.isError).toBe(true);
    expect(sentOps(sent).map(op => op.op)).toEqual(['desktop_input']);
  });

  it('reads a busy desktop and a desktop the machine reports down as errors the model can act on', async () => {
    const busy = providerWith({ refuse: { desktop_screenshot: refused('desktop_busy', 'busy') } });
    expect(
      text(await tool(desktopProviderTools(busy.provider).tools, 'computer_screenshot').execute({})).text,
    ).toContain('Another session');
    const down = providerWith({
      refuse: { desktop_screenshot: refused('bad_request', 'desktop_unavailable: Xvfb exited') },
    });
    const result = text(await tool(desktopProviderTools(down.provider).tools, 'computer_screenshot').execute({}));
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('Xvfb exited');
    expect(result.text).toContain('use exec');
  });
});
