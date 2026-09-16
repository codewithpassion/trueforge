import { InstructionBuilder } from '@truefoundry/trueforge-core/core/InstructionBuilder';
import type { IToolSet } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import type { Skill } from '@truefoundry/trueforge-core/core/sandbox/skills/SkillMounter';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { env } from 'cloudflare:workers';
import configuration from '../../src/config';
import type { SandboxProviderManifest } from '../../src/schemas/sandboxProvider';
import { createConsoleLogger } from '../../src/workers/logger';
import { createWorkersRuntimeDeps } from '../../src/workers/runtime';
import { CLOUDFLARE_COMPUTER_PROVIDER_TYPE } from '../../src/workers/sandbox/CloudflareComputerProvider';
import { createWorkersSandboxIntegration } from '../../src/workers/sandbox/workersSandboxIntegration';
import { d1Persistence, TENANT_ID } from './harness';

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

function storeInput() {
  return { tenant_id: TENANT_ID, sessionId: 'session-1', store: d1Persistence().sandboxProviderStore, logger };
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
});

describe('createWorkersRuntimeDeps', () => {
  it('leaves code execution off while the deploy sets no sandbox backend', async () => {
    expect(configuration.TRUEFORGE_SANDBOX_BACKEND).toBeUndefined();
    const { sandboxIntegration } = createWorkersRuntimeDeps(env);
    await expect(sandboxIntegration.resolveProvider(storeInput())).resolves.toBeUndefined();
    await expect(sandboxIntegration.checkSnapshotStatus(storeInput())).resolves.toBeUndefined();
    expect(sandboxIntegration.isLocalFallbackEnabled()).toBe(false);
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
});

describe.each([undefined, 'cloudflare-computer' as const])(
  'createWorkersSandboxIntegration (backend %s) runtime support',
  backend => {
    it('offers no local fallback, no skills and no Daytona settings surface', () => {
      const integration = build(backend);
      expect(integration.isLocalFallbackEnabled()).toBe(false);
      expect(integration.isSkillMountingSupported()).toBe(false);
      expect(integration.isDaytonaSettingsSupported()).toBe(false);
      expect(integration.isDaytonaAuthError(new Error('x'))).toBe(false);
      expect(integration.isDaytonaPermissionError(new Error('x'))).toBe(false);
    });

    it('refuses to build a Daytona provider', () => {
      expect(() =>
        build(backend).createDaytonaProvider({ manifest: DAYTONA_MANIFEST, tenant_id: TENANT_ID, logger }),
      ).toThrow(/not supported on the Cloudflare Workers runtime/);
    });

    it('refuses a turn sandbox that mounts skills, rather than dropping them silently', async () => {
      const integration = build(backend);
      const provider = await createWorkersSandboxIntegration({
        backend: 'cloudflare-computer',
        namespace: env.COMPUTER_DO,
        defaultExecTimeoutSeconds: 30,
        fileMaxBytesForDownload: 1024,
      }).resolveProvider(storeInput());
      if (provider === undefined) {
        throw new Error('expected a provider for the cloudflare-computer backend');
      }
      const turnSandbox = {
        provider,
        logger,
        fileDownloadEnabled: false,
        existingSandboxId: undefined,
        tracing: NOOP_AGENT_TRACING,
      };
      expect(() => integration.buildTurnSandbox({ ...turnSandbox, skills: [SKILL] })).toThrow(
        /skills are not available/,
      );
      expect(integration.buildTurnSandbox({ ...turnSandbox, skills: [] })).toBeDefined();
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
