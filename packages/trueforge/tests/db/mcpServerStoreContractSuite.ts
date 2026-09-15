/**
 * Backend-agnostic behavioural contract for IMcpServerStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import { McpServerNameConflictError, type IMcpServerStore } from '../../src/db/mcpServerStore';
import type { IOAuthTokenStore, OAuthClientRecord, OAuthToken } from '../../src/mcp/auth/types';
import type { RemoteMcpServerManifest } from '../../src/schemas/mcpServer';

const TENANT = 'default';

function manifest(overrides: Partial<RemoteMcpServerManifest> = {}): RemoteMcpServerManifest {
  return {
    type: 'remote',
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    description: 'Linear MCP server.',
    auth: { type: 'dcr' },
    ...overrides,
  };
}

const sampleOAuthClient: OAuthClientRecord = {
  server: {
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    codeChallengeMethodsSupported: ['S256'],
  },
  client: {
    clientId: 'client-1',
    clientSecret: 'secret-1',
  },
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const sampleToken: OAuthToken = {
  accessToken: 'access-1',
  refreshToken: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  scope: null,
};

export function runMcpServerStoreContractSuite(deps: {
  getStore: () => IMcpServerStore;
  /** Same database as `getStore`, to observe authorization resets. */
  getTokenStore: () => IOAuthTokenStore;
}): void {
  const { getStore } = deps;

  it('upsert creates a server and round-trips the manifest', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
    });

    expect(created.tenant_id).toBe(TENANT);
    expect(created.name).toBe('linear');
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.manifest).toEqual(manifest());
    expect(created.created_at).toMatch(ISO_UTC);
    expect(created.updated_at).toBe(created.created_at);

    const fetched = await store.getServer({ tenant_id: TENANT, name: 'linear' });
    expect(fetched).toEqual(created);
  });

  it('createServer inserts and throws McpServerNameConflictError on name clash', async () => {
    const store = getStore();
    const created = await store.createServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
    });
    expect(created.name).toBe('linear');

    await expect(
      store.createServer({ tenant_id: TENANT, name: 'linear', manifest: manifest() }),
    ).rejects.toBeInstanceOf(McpServerNameConflictError);
  });

  it('getServer returns undefined for unknown servers', async () => {
    const store = getStore();
    expect(await store.getServer({ tenant_id: TENANT, name: 'missing' })).toBeUndefined();
  });

  it('upsert replaces the manifest, preserves id and created_at', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
    });

    const replacement = manifest({
      name: 'linear',
      url: 'https://mcp.linear.app/mcp/v2',
    });
    const updated = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: replacement,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.manifest).toEqual(replacement);
    expect(updated.created_at).toBe(created.created_at);
    expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(created.updated_at));

    const servers = await store.listServers({
      tenant_id: TENANT,
      names: undefined,
    });
    expect(servers).toEqual([updated]);
  });

  it('listServers returns only the tenant, ordered by name', async () => {
    const store = getStore();
    await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest() });
    await store.upsertServer({
      tenant_id: TENANT,
      name: 'deepwiki',
      manifest: manifest({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }),
    });
    await store.upsertServer({ tenant_id: 'other-tenant', name: 'linear', manifest: manifest() });

    const servers = await store.listServers({
      tenant_id: TENANT,
      names: undefined,
    });
    expect(servers.map(server => server.name)).toEqual(['deepwiki', 'linear']);
    expect(servers.every(server => server.tenant_id === TENANT)).toBe(true);
  });

  it('listServers filters by names and returns empty for an empty name list', async () => {
    const store = getStore();
    await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest() });
    await store.upsertServer({
      tenant_id: TENANT,
      name: 'deepwiki',
      manifest: manifest({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }),
    });
    await store.upsertServer({
      tenant_id: TENANT,
      name: 'notion',
      manifest: manifest({ name: 'notion', url: 'https://mcp.notion.com/mcp' }),
    });

    const filtered = await store.listServers({
      tenant_id: TENANT,
      names: ['notion', 'missing', 'deepwiki'],
    });
    expect(filtered.map(server => server.name)).toEqual(['deepwiki', 'notion']);

    await expect(store.listServers({ tenant_id: TENANT, names: [] })).resolves.toEqual([]);
  });
  it('upsert leaves oauth columns null and does not clear a saved OAuth client', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
    });
    expect(await store.getClient({ id: created.id })).toBeUndefined();

    await store.saveClient({ id: created.id, record: sampleOAuthClient });
    expect(await store.getClient({ id: created.id })).toEqual(sampleOAuthClient);

    await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest({ url: 'https://mcp.linear.app/mcp/v2' }),
    });
    expect(await store.getClient({ id: created.id })).toEqual(sampleOAuthClient);
  });

  it('create and upsert write oauth_client with the row when given', async () => {
    const store = getStore();
    const created = await store.createServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
      oauth_client: sampleOAuthClient,
    });
    expect(await store.getClient({ id: created.id })).toEqual(sampleOAuthClient);

    const rotated: OAuthClientRecord = {
      ...sampleOAuthClient,
      client: { clientId: 'client-2', clientSecret: 'secret-2' },
    };
    const updated = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest({ url: 'https://mcp.linear.app/mcp/v2' }),
      oauth_client: rotated,
      reset_authorizations: true,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.manifest).toEqual(manifest({ url: 'https://mcp.linear.app/mcp/v2' }));
    expect(await store.getClient({ id: created.id })).toEqual(rotated);
  });

  it('upsert with reset_authorizations deletes every token and pending authorization; without it keeps them', async () => {
    const store = getStore();
    const tokenStore = deps.getTokenStore();
    const created = await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest() });
    const seedAuthorizations = async (): Promise<void> => {
      await tokenStore.saveToken({ id: created.id, userRef: 'user-a', token: sampleToken });
      await tokenStore.saveToken({ id: created.id, userRef: 'user-b', token: sampleToken });
      await tokenStore.savePendingAuthorization({
        state: 'pending-state',
        id: created.id,
        userRef: 'user-a',
        mcpServerUrl: manifest().url,
        codeVerifier: 'verifier',
        returnTo: null,
      });
    };

    await seedAuthorizations();
    await store.upsertServer({ tenant_id: TENANT, name: 'linear', manifest: manifest({ description: 'Kept.' }) });
    expect(await tokenStore.getToken({ id: created.id, userRef: 'user-a' })).toEqual(sampleToken);

    await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest({ url: 'https://mcp.linear.app/mcp/v2' }),
      reset_authorizations: true,
    });
    expect(await tokenStore.getToken({ id: created.id, userRef: 'user-a' })).toBeUndefined();
    expect(await tokenStore.getToken({ id: created.id, userRef: 'user-b' })).toBeUndefined();
    expect(await tokenStore.consumePendingAuthorization({ state: 'pending-state' })).toBeUndefined();
  });

  it('save/get/delete OAuth client round-trips and clears registration', async () => {
    const store = getStore();
    const created = await store.upsertServer({
      tenant_id: TENANT,
      name: 'linear',
      manifest: manifest(),
    });

    await store.saveClient({ id: created.id, record: sampleOAuthClient });
    expect(await store.getClient({ id: created.id })).toEqual(sampleOAuthClient);

    await store.deleteClient({ id: created.id });
    expect(await store.getClient({ id: created.id })).toBeUndefined();
  });

  it('getClient returns undefined for unknown server ids', async () => {
    const store = getStore();
    expect(await store.getClient({ id: 'missing-id' })).toBeUndefined();
  });
}
