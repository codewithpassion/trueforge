import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { InstructionBuilder } from '@truefoundry/trueforge-core/core/InstructionBuilder';
import type { IToolSet } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import type { Skill } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { env } from 'cloudflare:workers';
import configuration from '../../src/config';
import { validateAgentSpec } from '../../src/runtime/sessionResources';
import type { SandboxIntegration } from '../../src/sandbox/integration';
import type { SandboxProviderManifest } from '../../src/schemas/sandboxProvider';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersRuntimeDeps } from '../../src/workers/runtime';
import {
  CLOUDFLARE_COMPUTER_PROVIDER_TYPE,
  CloudflareComputerProvider,
} from '../../src/workers/sandbox/CloudflareComputerProvider';
import type { ComputerWorkspace } from '../../src/workers/sandbox/ComputerDO';
import { createWorkersSandboxIntegration } from '../../src/workers/sandbox/workersSandboxIntegration';
import { d1Persistence, FakeComputer, migrateDatabase, TENANT_ID, upsertMockProvider } from './harness';

const logger = createConsoleLogger({ level: 'error', bindings: {} });

const DAYTONA_MANIFEST: SandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60_000,
  auto_stop_interval_in_minutes: 15,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 0,
};

/** Stands in for a configured MCP server on the turn's main thread. */
const MCP_TOOL_SET: IToolSet = {
  name: 'context7',
  id: 'context7',
  preload: false,
  hasPreloadedTools: false,
  listTools: () => Promise.reject(new Error('not used by this test')),
  callTool: () => Promise.reject(new Error('not used by this test')),
  toolCallInfo: () => Promise.reject(new Error('not used by this test')),
};

const SKILL: Skill = {
  type: 'git',
  name: 'demo',
  description: 'a skill',
  url: 'https://github.com/example/skills.git',
  path: 'demo',
  ref: 'main',
};

const SANDBOX_ID = `${TENANT_ID}:session-1`;

function computerProvider(computer: ComputerWorkspace): CloudflareComputerProvider {
  return new CloudflareComputerProvider({
    computer,
    sandboxId: SANDBOX_ID,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 1024,
  });
}

function storeInput() {
  return { tenant_id: TENANT_ID, sessionId: 'session-1', store: d1Persistence().sandboxProviderStore, logger };
}

/** The agent-create and session-create gate, which reads the sandbox-provider table. */
async function validateSandboxSpec(sandboxIntegration: SandboxIntegration): Promise<void> {
  await migrateDatabase();
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: 'text' });
  await validateAgentSpec({
    spec: AgentSpecSchema.parse({
      model: { name: `${providerName}/mock-model` },
      config: { sandbox: { enabled: true, file_downloads: false } },
    }),
    tenant_id: TENANT_ID,
    modelProviderStore: stores.modelProviderStore,
    mcpServerStore: stores.mcpServerStore,
    skillStore: stores.skillStore,
    sandboxProviderStore: stores.sandboxProviderStore,
    sandboxIntegration,
  });
}

function build(backend: 'cloudflare-computer' | undefined) {
  return createWorkersSandboxIntegration({
    backend,
    namespace: env.COMPUTER_DO,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 1024,
  });
}

describe('createWorkersSandboxIntegration with TRUEFORGE_SANDBOX_BACKEND unset', () => {
  it('resolves no provider, which is what keeps code execution off', async () => {
    await expect(build(undefined).resolveProvider(storeInput())).resolves.toBeUndefined();
  });

  it('reports no image status, so a sandbox-enabled turn keeps its 422', async () => {
    await expect(build(undefined).checkSnapshotStatus(storeInput())).resolves.toBeUndefined();
  });

  it('offers no sandbox without a stored record, so a sandbox-enabled spec is rejected', async () => {
    expect(build(undefined).isSandboxUsableWithoutStoredRecord()).toBe(false);
    await expect(validateSandboxSpec(build(undefined))).rejects.toThrow(/no sandbox provider is configured/);
  });
});

describe('createWorkersRuntimeDeps', () => {
  it('leaves code execution off while the deploy sets no sandbox backend', async () => {
    expect(configuration.TRUEFORGE_SANDBOX_BACKEND).toBeUndefined();
    const { sandboxIntegration } = createWorkersRuntimeDeps(env);
    await expect(sandboxIntegration.resolveProvider(storeInput())).resolves.toBeUndefined();
    await expect(sandboxIntegration.checkSnapshotStatus(storeInput())).resolves.toBeUndefined();
    expect(sandboxIntegration.isSandboxUsableWithoutStoredRecord()).toBe(false);
  });
});

describe('createWorkersSandboxIntegration with TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer', () => {
  it('binds the provider to this session own workspace', async () => {
    const provider = await build('cloudflare-computer').resolveProvider(storeInput());
    expect(provider?.type).toBe(CLOUDFLARE_COMPUTER_PROVIDER_TYPE);
    await expect(provider?.createSandbox()).resolves.toEqual({ sandboxId: `${TENANT_ID}:session-1` });
  });

  it('reports the rolled container image as ready', async () => {
    await expect(build('cloudflare-computer').checkSnapshotStatus(storeInput())).resolves.toEqual({
      status: 'ready',
      status_reason: null,
      build_metadata: null,
    });
  });

  // An agent that drops its last skill still has to reach the downloader, or the old install stays.
  it.each([
    ['one skill', [SKILL], '[{"type":"git","name":"demo"'],
    ['no skills', [], '{"skills":[]}'],
  ])('runs the skill downloader on init with %s', async (_label, skills, requested) => {
    const computer = new FakeComputer();
    const sandbox = build('cloudflare-computer').buildTurnSandbox({
      provider: computerProvider(computer),
      logger,
      skills,
      fileDownloadEnabled: false,
      existingSandboxId: undefined,
      tracing: NOOP_AGENT_TRACING,
    });

    // An upload is the cheapest public entry point that drives the one-off sandbox init.
    await sandbox.uploadFile({ targetDir: '/workspace/uploads', fileName: 'a.txt', content: Buffer.from('x') });

    const download = computer.execCalls.find(call => call.command.includes('skill_downloader.py'));
    expect(download?.env).toEqual({ TFY_SKILLS_DIR: '/workspace/.trueforge/skills' });
    const upload = computer.writes.find(
      write => write.path === '/workspace/.trueforge/skills/.tfy-requested-skills.json',
    );
    expect(Buffer.from(upload?.content ?? new Uint8Array()).toString()).toContain(requested);
  });

  // Reattaching is the path that retries a failed init, so a capacity failure must not look like a
  // gone sandbox: recreating spends the container health-check budget again before anyone sees why.
  it('gives up after one init attempt when the deploy is at its container limit', async () => {
    const computer = new FakeComputer();
    computer.exec = new Error(
      'connect failed at stage=health port=8080 attempt=2/2 timeoutMs=30000 lastError=container exited: ' +
        'Maximum number of running container instances exceeded. Try again later.',
    );
    const sandbox = build('cloudflare-computer').buildTurnSandbox({
      provider: computerProvider(computer),
      logger,
      skills: [],
      fileDownloadEnabled: false,
      existingSandboxId: `v1:${CLOUDFLARE_COMPUTER_PROVIDER_TYPE}:${SANDBOX_ID}`,
      tracing: NOOP_AGENT_TRACING,
    });

    await expect(
      sandbox.uploadFile({ targetDir: '/workspace/uploads', fileName: 'a.txt', content: Buffer.from('x') }),
    ).rejects.toThrow(/max_instances/);
    expect(computer.execCalls).toHaveLength(1);
  });

  it('mounts a requested skill into the workspace skills directory', () => {
    const sandbox = build('cloudflare-computer').buildTurnSandbox({
      provider: computerProvider(new FakeComputer()),
      logger,
      skills: [SKILL],
      fileDownloadEnabled: false,
      existingSandboxId: undefined,
      tracing: NOOP_AGENT_TRACING,
    });
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    expect(builder.build()).toContain('/workspace/.trueforge/skills/demo');
  });

  it('accepts a sandbox-enabled spec with nothing in the sandbox-provider table', async () => {
    expect(build('cloudflare-computer').isSandboxUsableWithoutStoredRecord()).toBe(true);
    await expect(validateSandboxSpec(build('cloudflare-computer'))).resolves.toBeUndefined();
  });
});

describe.each([undefined, 'cloudflare-computer' as const])(
  'createWorkersSandboxIntegration (backend %s) runtime support',
  backend => {
    it('follows the workspace with skills, and offers no Daytona settings surface', () => {
      const integration = build(backend);
      expect(integration.isSkillMountingSupported()).toBe(backend !== undefined);
      expect(integration.isDaytonaSettingsSupported()).toBe(false);
      expect(integration.isDaytonaAuthError(new Error('x'))).toBe(false);
      expect(integration.isDaytonaPermissionError(new Error('x'))).toBe(false);
    });

    it('refuses to build a Daytona provider', () => {
      expect(() =>
        build(backend).createDaytonaProvider({ manifest: DAYTONA_MANIFEST, tenant_id: TENANT_ID, logger }),
      ).toThrow(/not supported on the Cloudflare Workers runtime/);
    });

    it('builds a turn sandbox that carries MCP servers without asking for a Code Mode transport', async () => {
      const provider = await build('cloudflare-computer').resolveProvider(storeInput());
      if (provider === undefined) {
        throw new Error('expected a provider for the cloudflare-computer backend');
      }
      const sandbox = build(backend).buildTurnSandbox({
        provider,
        logger,
        skills: [],
        fileDownloadEnabled: false,
        existingSandboxId: undefined,
        tracing: NOOP_AGENT_TRACING,
      });

      // The turn wires Code Mode from the main thread's tool sets before any thread runs.
      expect(() => {
        sandbox.configureCodeMode([MCP_TOOL_SET]);
      }).not.toThrow();

      const builder = new InstructionBuilder('root');
      sandbox.buildInstruction(builder);
      const prompt = builder.build();
      // No in-sandbox client is installed, so the prompt must not send the model to one.
      expect(prompt).not.toContain('mcp_client');
      expect(prompt).toContain('/workspace/uploads/');
    });
  },
);
