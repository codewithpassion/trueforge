import { createLogger } from 'winston';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import type { LocalSandboxSupportResult } from '../../../src/sandbox/local/provider/LocalSandboxProvider';
import { createNodeSandboxIntegration, localSandboxSessionSegment } from '../../../src/sandbox/nodeSandboxIntegration';
import { SANDBOX_READY_STATUS, type StoredSandboxProviderManifest } from '../../../src/schemas/sandboxProvider';

const logger = createLogger({ silent: true });
const TENANT = 'default';

const LOCAL_SUPPORTED: LocalSandboxSupportResult = {
  supported: true,
  platform: 'darwin',
  shell: '/bin/bash',
  python: '/usr/bin/python3',
};

async function storeWith(manifest: StoredSandboxProviderManifest): Promise<SqliteSandboxProviderStore> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new SqliteSandboxProviderStore(db);
  await store.upsertSandboxProvider({ tenant_id: TENANT, manifest, ...SANDBOX_READY_STATUS });
  return store;
}

describe('localSandboxSessionSegment', () => {
  it('keeps a single-segment session id and rejects missing or unsafe values', () => {
    expect(localSandboxSessionSegment('sess_1')).toBe('sess_1');
    expect(localSandboxSessionSegment(undefined)).toBe('_');
    expect(localSandboxSessionSegment('')).toBe('_');
    expect(localSandboxSessionSegment('a/b')).toBe('_');
    expect(localSandboxSessionSegment('..')).toBe('_');
    expect(localSandboxSessionSegment('foo..bar')).toBe('_');
  });
});

describe('createNodeSandboxIntegration', () => {
  it('offers no settings-managed built-in provider', () => {
    const integration = createNodeSandboxIntegration({ localSupport: LOCAL_SUPPORTED });
    expect(integration.isDaytonaSettingsSupported()).toBe(true);
    expect(integration.isCloudflareComputerSettingsSupported()).toBe(false);
  });

  it('uses the local fallback only for a supported standalone probe', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteSandboxProviderStore(db);
    const usability = (localSupport: LocalSandboxSupportResult | undefined) =>
      createNodeSandboxIntegration({ localSupport }).resolveSandboxUsability({ store, tenant_id: TENANT, logger });

    await expect(usability(undefined)).resolves.toEqual({ usable: false, status: undefined });
    await expect(usability({ supported: false, reason: 'no bubblewrap' })).resolves.toEqual({
      usable: false,
      status: undefined,
    });
    await expect(usability(LOCAL_SUPPORTED)).resolves.toEqual({ usable: true, status: undefined });
  });

  /**
   * A `cloudflare-computer` row can reach a Node database — a restored dump, or a database
   * shared with a Workers deploy. Attaching to it needs a Durable Object this process has no
   * access to, so it must read as "nothing stored" rather than be handed to the Daytona client.
   */
  describe('with a cloudflare-computer record it cannot attach to', () => {
    it('reports no sandbox instead of throwing', async () => {
      const store = await storeWith({ type: 'cloudflare-computer' });
      const integration = createNodeSandboxIntegration({ localSupport: undefined });

      await expect(integration.resolveSandboxUsability({ store, tenant_id: TENANT, logger })).resolves.toEqual({
        usable: false,
        status: undefined,
      });
      await expect(integration.checkSnapshotStatus({ store, tenant_id: TENANT, logger })).resolves.toBeUndefined();
    });

    // The row reads as "nothing stored", so the fallback decides — not the unusable record.
    it('falls through to the local fallback', async () => {
      const store = await storeWith({ type: 'cloudflare-computer' });
      const integration = createNodeSandboxIntegration({ localSupport: LOCAL_SUPPORTED });

      await expect(integration.resolveSandboxUsability({ store, tenant_id: TENANT, logger })).resolves.toEqual({
        usable: true,
        status: undefined,
      });
    });
  });

  // TrueFoundry rows carry a prebuilt image, so their persisted status passes straight through.
  it('reports a prebuilt provider from its persisted status without a build check', async () => {
    const store = await storeWith({
      type: 'truefoundry',
      server_url: 'http://sandbox-server',
      nats_bridge_url: 'ws://nats-bridge',
      exec_timeout_ms: 60_000,
    });
    const integration = createNodeSandboxIntegration({ localSupport: undefined });

    await expect(integration.resolveSandboxUsability({ store, tenant_id: TENANT, logger })).resolves.toEqual({
      usable: true,
      status: 'ready',
    });

    await store.updateSandboxStatus({
      tenant_id: TENANT,
      status: 'pending',
      status_reason: null,
      build_metadata: null,
    });
    await expect(integration.resolveSandboxUsability({ store, tenant_id: TENANT, logger })).resolves.toEqual({
      usable: false,
      status: 'pending',
    });
  });
});
