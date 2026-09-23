import { InstructionBuilder } from '@truefoundry/trueforge-core/core/InstructionBuilder';
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
import { TurnDesktopLeases } from '../../../src/computers/turnDesktopLeases';
import type { AppendComputerAuditInput } from '../../../src/db/computerStore';

const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
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
  const audited: AppendComputerAuditInput[] = [];
  const leases = new TurnDesktopLeases();
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
      releaseLease: () => Promise.reject(new Error('not used')),
      recordTakeoverPointer: () => Promise.reject(new Error('not used')),
      clearTakeoverPointer: () => Promise.reject(new Error('not used')),
      listTakeoverPointers: () => Promise.reject(new Error('not used')),
      takeHumanLease: () => Promise.reject(new Error('not used')),
      releaseHumanLease: () => Promise.reject(new Error('not used')),
      revoke: () => Promise.reject(new Error('not used')),
      disconnect: () => Promise.reject(new Error('not used')),
      destroy: () => Promise.reject(new Error('not used')),
      status: () => Promise.reject(new Error('not used')),
    },
    computerId: 'cmp_1',
    computerName: 'office-box',
    tenantId: 'default',
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    workdir: '/var/lib/x/sessions',
    capabilities,
    requireApproval,
    defaultExecTimeoutSeconds: 10,
    fileMaxBytesForDownload: 1024,
    store: {
      appendAudit: row => {
        audited.push(row);
        return Promise.resolve();
      },
    },
    desktopLeases: leases,
    logger: createLogger({ silent: true }),
  });
  return { provider, sent, audited, leases };
}

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find(candidate => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return found;
}

/** The image part the harness stores; it reads the size from the image header, not from `_meta`. */
const SCREENSHOT_PART = {
  type: 'image',
  data: SCREENSHOT.data_b64,
  mimeType: 'image/jpeg',
  _meta: { width: 1280, height: 800 },
};

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
      desktopProviderTools({ provider, modelAcceptsToolImages: true })
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
    const offered = desktopProviderTools({ provider, modelAcceptsToolImages: true });
    expect(offered.tools.map(candidate => candidate.name).sort()).toEqual([
      'computer_clipboard_read',
      'computer_screenshot',
    ]);
    expect(offered.instructions).toContain('approve each action');
  });

  it('returns the screenshot as an image whatever the model, and tells a model without images to use exec', async () => {
    const { provider } = providerWith({});
    const offered = desktopProviderTools({ provider, modelAcceptsToolImages: false });
    // The text stub a model without images sees is made per request from the provider table, not here.
    expect(await tool(offered.tools, 'computer_screenshot').execute({})).toEqual({
      result: { content: [SCREENSHOT_PART] },
      wasInitialized: undefined,
    });
    expect(offered.instructions).toContain('does not receive images');
    expect(desktopProviderTools({ provider, modelAcceptsToolImages: true }).instructions).not.toContain(
      'does not receive images',
    );
  });

  it('offers nothing on a machine whose desktop is down, and tells the model why', () => {
    const { provider } = providerWith({
      capabilities: { ...DESKTOP, desktop: false, desktop_unavailable_reason: 'xdotool is missing' },
    });
    const offered = desktopProviderTools({ provider, modelAcceptsToolImages: true });
    expect(offered.tools).toEqual([]);
    expect(offered.instructions).toContain('xdotool is missing');
  });

  it('clicks, waits, then screenshots, as the session, returning the screenshot', async () => {
    const { provider, sent } = providerWith({});
    const response = await tool(
      desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools,
      'computer_click',
    ).execute({ x: 100, y: 200 });

    expect(response).toEqual({ result: { content: [SCREENSHOT_PART] }, wasInitialized: undefined });
    expect(sentOps(sent)).toEqual([
      { op: 'desktop_input', actions: [{ type: 'click', x: 100, y: 200, button: 'left', count: 1 }] },
      { op: 'desktop_screenshot', quality: null },
    ]);
    expect(sent.map(input => input.principal)).toEqual([
      { kind: 'agent', session_id: SESSION_ID, turn_id: TURN_ID },
      { kind: 'agent', session_id: SESSION_ID, turn_id: TURN_ID },
    ]);
    expect(sent.map(input => input.timeout_ms)).toEqual([2000, 5000]);
  });

  it('drags as move, press, move, release in one input', async () => {
    const { provider, sent } = providerWith({});
    await tool(desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools, 'computer_drag').execute({
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
    await tool(desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools, 'computer_type').execute({
      text: 'x'.repeat(512),
    });
    expect(sent[0]?.timeout_ms).toBe(2000 + 5 * 512);
  });

  it('reads the clipboard as text and writes both selections', async () => {
    const { provider, sent } = providerWith({});
    const { tools } = desktopProviderTools({ provider, modelAcceptsToolImages: true });
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

  it('tells every thread to ask for a takeover if it can, else to stop and tell the user', async () => {
    const { provider } = providerWith({ refuse: { desktop_screenshot: refused('human_in_control', 'paused') } });
    const result = text(
      await tool(desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools, 'computer_screenshot').execute(
        {},
      ),
    );
    expect(result).toEqual({
      text: 'A person is using the desktop. If request_human_takeover is among your tools and you need them, call it; otherwise stop and tell the user.',
      isError: true,
    });
  });

  it('offers request_human_takeover to the root thread only, and names it only there', async () => {
    for (const requireApproval of [false, true]) {
      const offered = desktopProviderTools({
        provider: providerWith({ requireApproval }).provider,
        modelAcceptsToolImages: true,
      });
      // Sub-agent threads share the sandbox instructions but not the tool, so only the root capability names it.
      expect(offered.instructions).not.toContain('request_human_takeover');
      const root = offered.rootCapability;
      const rootText = new InstructionBuilder('root');
      for (const build of root?.instructionBuilders ?? []) {
        build(rootText);
      }
      expect(rootText.build()).toContain('call request_human_takeover');
      expect(root?.systemToolSets).toHaveLength(1);
      const takeover = root?.systemToolSets?.[0];
      if (takeover === undefined) {
        throw new Error('expected the takeover tool set');
      }
      const listed = await takeover.listTools();
      if (!('result' in listed)) {
        throw new Error('expected a tool list');
      }
      expect(listed.result.tools.map(candidate => candidate.name)).toEqual(['request_human_takeover']);
      const info = await takeover.toolCallInfo({ name: 'request_human_takeover', arguments: { reason: 'log in' } });
      expect(info.is_client_side).toBe(true);
    }

    const down = desktopProviderTools({
      provider: providerWith({ capabilities: { ...DESKTOP, desktop: false, desktop_unavailable_reason: 'no X' } })
        .provider,
      modelAcceptsToolImages: true,
    });
    expect(down.rootCapability).toBeUndefined();
    expect(down.instructions).not.toContain('request_human_takeover');
  });

  it('says the action already ran when only the screenshot after it was refused', async () => {
    const { provider, sent } = providerWith({ refuse: { desktop_screenshot: refused('human_in_control', 'paused') } });
    const result = text(
      await tool(desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools, 'computer_type').execute({
        text: 'hi',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^The action already ran, but the screenshot after it was refused\. A person is using/);
    expect(sentOps(sent).map(op => op.op)).toEqual(['desktop_input', 'desktop_screenshot']);
  });

  it('runs parallel calls one after another, so actions and screenshots never interleave', async () => {
    const { provider, sent } = providerWith({});
    const { tools } = desktopProviderTools({ provider, modelAcceptsToolImages: true });
    await Promise.all([
      tool(tools, 'computer_click').execute({ x: 1, y: 1 }),
      tool(tools, 'computer_key').execute({ keys: 'Return' }),
      tool(tools, 'computer_screenshot').execute({}),
    ]);
    expect(sentOps(sent).map(op => op.op)).toEqual([
      'desktop_input',
      'desktop_screenshot',
      'desktop_input',
      'desktop_screenshot',
      'desktop_screenshot',
    ]);
  });

  it('records the lease for the turn before the op leaves, even when the op is refused', async () => {
    const { provider, leases } = providerWith({ refuse: { desktop_screenshot: refused('desktop_busy', 'busy') } });
    await tool(desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools, 'computer_screenshot').execute(
      {},
    );
    expect(leases.take(TURN_ID)).toEqual(['cmp_1']);
    expect(leases.take(TURN_ID)).toEqual([]);
  });

  it('audits each desktop op by name and action count, never what was typed or copied', async () => {
    const { provider, audited } = providerWith({ refuse: { desktop_clipboard_get: refused('desktop_busy', 'busy') } });
    const { tools } = desktopProviderTools({ provider, modelAcceptsToolImages: true });
    await tool(tools, 'computer_type').execute({ text: 'hunter2' });
    await tool(tools, 'computer_clipboard_write').execute({ text: 'secret' });
    await tool(tools, 'computer_clipboard_read').execute({});
    expect(audited.map(row => ({ op: row.op, command: row.command, outcome: row.outcome }))).toEqual([
      { op: 'desktop', command: 'desktop_input (1 action)', outcome: 'ok' },
      { op: 'desktop', command: 'desktop_screenshot', outcome: 'ok' },
      { op: 'desktop', command: 'desktop_clipboard_set', outcome: 'ok' },
      { op: 'desktop', command: 'desktop_screenshot', outcome: 'ok' },
      { op: 'desktop', command: 'desktop_clipboard_get', outcome: 'desktop_busy' },
    ]);
    expect(audited.every(row => row.session_id === SESSION_ID && row.turn_id === TURN_ID)).toBe(true);
    expect(JSON.stringify(audited)).not.toMatch(/hunter2|secret/);
  });

  it.each([
    ['computer_key', { keys: 'ctrl+l; rm -rf /' }],
    ['computer_scroll', { x: 1, y: 1, dx: 40, dy: 40 }],
    ['computer_click', { x: 1280, y: 0 }],
    ['computer_clipboard_write', { text: 'x'.repeat(64 * 1024 + 1) }],
  ])('refuses %s input the machine would reject, before it leaves', async (name, input) => {
    const { provider, sent } = providerWith({});
    const result = text(
      await tool(desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools, name).execute(input),
    );
    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('does not screenshot after an action a person interrupted', async () => {
    const { provider, sent } = providerWith({ refuse: { desktop_input: refused('human_in_control', 'paused') } });
    const result = text(
      await tool(desktopProviderTools({ provider, modelAcceptsToolImages: true }).tools, 'computer_key').execute({
        keys: 'Return',
      }),
    );
    expect(result.isError).toBe(true);
    expect(sentOps(sent).map(op => op.op)).toEqual(['desktop_input']);
  });

  it('reads a busy desktop and a desktop the machine reports down as errors the model can act on', async () => {
    const busy = providerWith({ refuse: { desktop_screenshot: refused('desktop_busy', 'busy') } });
    expect(
      text(
        await tool(
          desktopProviderTools({ provider: busy.provider, modelAcceptsToolImages: true }).tools,
          'computer_screenshot',
        ).execute({}),
      ).text,
    ).toContain('Another session');
    const down = providerWith({
      refuse: { desktop_screenshot: refused('bad_request', 'desktop_unavailable: Xvfb exited') },
    });
    const result = text(
      await tool(
        desktopProviderTools({ provider: down.provider, modelAcceptsToolImages: true }).tools,
        'computer_screenshot',
      ).execute({}),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('Xvfb exited');
    expect(result.text).toContain('use exec');
  });
});
