import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

function makeProvider(supportsCodeMode: boolean, createCodeModeTransport: jest.Mock): SandboxProvider {
  return {
    type: 'test',
    supportsCodeMode,
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: () => Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } }),
    getAdditionalInstructions: () => undefined,
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/skill_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport,
  };
}

function makeSandbox(provider: SandboxProvider): Sandbox {
  return new Sandbox({
    provider,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

function toolSets(): IToolSet[] {
  return [makeMockIMCPServer({ name: 'context7', preload: false })];
}

describe('Sandbox.configureCodeMode', () => {
  it('builds the transport when the provider supports Code Mode', () => {
    const createCodeModeTransport = jest.fn().mockReturnValue({ start: jest.fn(), stop: jest.fn() });
    const sandbox = makeSandbox(makeProvider(true, createCodeModeTransport));

    sandbox.configureCodeMode(toolSets());

    expect(createCodeModeTransport).toHaveBeenCalledTimes(1);
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    expect(builder.build()).toContain('context7');
  });

  it('leaves Code Mode unconfigured when the provider does not support it', () => {
    const createCodeModeTransport = jest.fn();
    const sandbox = makeSandbox(makeProvider(false, createCodeModeTransport));

    expect(() => {
      sandbox.configureCodeMode(toolSets());
    }).not.toThrow();

    expect(createCodeModeTransport).not.toHaveBeenCalled();
  });

  it('keeps the mcp_client instructions out of the prompt when Code Mode is unsupported', () => {
    const sandbox = makeSandbox(makeProvider(false, jest.fn()));
    sandbox.configureCodeMode(toolSets());

    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    const prompt = builder.build();

    expect(prompt).not.toContain('mcp_client');
    // The sandbox itself is still described, so exec and the uploads layout stay available.
    expect(prompt).toContain('/prov/uploads/');
  });

  it('never asks an unsupporting provider for a transport, even with no tool sets', () => {
    const createCodeModeTransport = jest.fn();
    makeSandbox(makeProvider(false, createCodeModeTransport)).configureCodeMode([]);
    expect(createCodeModeTransport).not.toHaveBeenCalled();
  });
});
