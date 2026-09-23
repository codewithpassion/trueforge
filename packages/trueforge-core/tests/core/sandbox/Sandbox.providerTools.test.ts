import { z } from 'zod';
import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool } from '../../../src/core/mcp/LocalToolMCP';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function makeProvider(createSandbox: SandboxProvider['createSandbox']): SandboxProvider {
  return {
    type: 'local',
    supportsCodeMode: false,
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox,
    exec: () => Promise.resolve({ success: true, response: { exitCode: 0, result: '' } }),
    getAdditionalInstructions: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/skill_downloader.py`,
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(input: { provider: SandboxProvider; existingSandboxId?: string; ran: string[] }): Sandbox {
  return new Sandbox({
    provider: input.provider,
    existingSandboxId: input.existingSandboxId,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    providerTools: {
      tools: [
        defineTool({
          name: 'look',
          description: 'Looks.',
          schema: z.object({}),
          handler: () => {
            input.ran.push('look');
            return Promise.resolve(toolResultResponse({ text: 'seen' }));
          },
        }),
      ],
      instructions: 'You can look.',
    },
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

describe('Sandbox provider tools', () => {
  it('lists them beside exec and explains them in the prompt', async () => {
    const sandbox = makeSandbox({ provider: makeProvider(jest.fn()), ran: [] });
    const listed = await sandbox.listTools();
    if (!('result' in listed)) {
      throw new Error('expected a tool list');
    }
    expect(listed.result.tools.map(tool => tool.name)).toEqual(['exec', 'look']);
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    expect(builder.build()).toContain('You can look.');
  });

  it('creates the sandbox before the first call and reports it like exec does', async () => {
    const ran: string[] = [];
    const createSandbox = jest.fn(() => {
      ran.push('create');
      return Promise.resolve({ sandboxId: 'raw-1' });
    });
    const sandbox = makeSandbox({ provider: makeProvider(createSandbox), ran });

    const first = await sandbox.callTool({ name: 'look', arguments: {} });
    const second = await sandbox.callTool({ name: 'look', arguments: {} });

    expect(ran).toEqual(['create', 'look', 'look']);
    if (!isCallToolResponseResult(first) || !isCallToolResponseResult(second)) {
      throw new Error('expected tool results');
    }
    expect(first).toMatchObject({ sandboxCreated: true, sandboxInfo: { sandbox_id: 'v1:local:raw-1' } });
    expect(second).toMatchObject({ sandboxCreated: false, sandboxInfo: { sandbox_id: 'v1:local:raw-1' } });
  });

  it('reuses a sandbox the session already has', async () => {
    const createSandbox = jest.fn();
    const sandbox = makeSandbox({ provider: makeProvider(createSandbox), existingSandboxId: 'v1:local:kept', ran: [] });

    const result = await sandbox.callTool({ name: 'look', arguments: {} });

    expect(createSandbox).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sandboxCreated: false, sandboxInfo: { sandbox_id: 'v1:local:kept' } });
  });
});
