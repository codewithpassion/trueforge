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
  },
);
