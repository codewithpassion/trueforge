import { OpenAPIHono } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  InMemoryFileObjectStore,
  SessionFileStore,
  Sessions,
  type IFileStore,
} from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import { createSessionsRouter } from '../../../src/apis/sessions';
import { TrueForgeAuthorizer, type Authorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT, type RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionFileMetadataStore } from '../../../src/db/sqlite/session-file-store/SqliteSessionFileMetadataStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import type { Database } from '../../../src/db/sqlite/types';
import { testNodeTurnExecutor } from '../runtime/testNodeTurnExecutor';

const CREATOR = STANDALONE_REQUEST_CONTEXT;
const OTHER_USER: RequestContext = {
  ...CREATOR,
  subject: { id: 'someone-else', type: 'user', display_name: 'someone-else' },
};
const FOREIGN_TENANT: RequestContext = { ...CREATOR, tenant_id: 'other-tenant' };
const SESSION_ID = 'ses_files';
const MANAGED_SESSION_ID = 'ses_managed';
const MANAGED_AGENT_EXTERNAL_ID = 'managed-agent-external';
const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 255);
const INLINE_SPEC = AgentSpecSchema.parse({ model: { name: 'anthropic/claude-sonnet-4-6' }, instructions: 'files' });

/** Grants `manage` on the managed agent only, as an explicit grant (not `all`). */
const managerAuthorizer: Authorizer = {
  listAgentAccess: input =>
    Promise.resolve({
      kind: 'agent_external_ids',
      agent_external_ids: input.action === 'manage' ? [MANAGED_AGENT_EXTERNAL_ID] : [],
    }),
  canAccessAgent: () => Promise.resolve(false),
  getPermissions: async ({ resourceType, resourceIds }) => ({
    type: resourceType,
    permissions: Object.fromEntries(resourceIds.map(id => [id, []])),
  }),
};

describe('GET /{session_id}/files/{file_id}', () => {
  let db: Kysely<Database>;
  let app: OpenAPIHono;
  let objects: InMemoryFileObjectStore;
  let fileStore: SessionFileStore;
  let routeFileStore: IFileStore;
  let caller: RequestContext;
  let authorizer: Authorizer;

  beforeEach(async () => {
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const sessionStore = new SqliteSessionStore(db, new BetterSqliteAtomicRunner(db));
    objects = new InMemoryFileObjectStore();
    fileStore = new SessionFileStore({ objects, metadata: new SqliteSessionFileMetadataStore(db) });
    routeFileStore = fileStore;
    caller = CREATOR;
    authorizer = new TrueForgeAuthorizer();
    app = new OpenAPIHono();
    app.route(
      '/',
      createSessionsRouter({
        sessions: new Sessions({ sessionStore }),
        sessionStore,
        fileStore: {
          put: input => routeFileStore.put(input),
          get: input => routeFileStore.get(input),
          deleteSession: input => routeFileStore.deleteSession(input),
        },
        resolveModelProviderStore: () => new SqliteModelProviderStore(db),
        resolveMcpServerStore: () => new SqliteMcpServerStore(db, new BetterSqliteAtomicRunner(db)),
        resolveSkillStore: () => new SqliteSkillStore(db),
        resolveAgentStore: () => new SqliteAgentStore(db),
        resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
        sandboxIntegration: undefined,
        turnExecutor: testNodeTurnExecutor({ sessionStore }),
        resolveRequestContext: () => caller,
        authorizer: {
          listAgentAccess: input => authorizer.listAgentAccess(input),
          canAccessAgent: input => authorizer.canAccessAgent(input),
          getPermissions: input => authorizer.getPermissions(input),
        },
        logger: createLogger({ silent: true }),
      }),
    );
    await sessionStore.createSession({
      tenant_id: CREATOR.tenant_id,
      session_id: SESSION_ID,
      created_by_subject: {
        subject_id: CREATOR.subject.id,
        subject_type: CREATOR.subject.type,
        subject_display_name: CREATOR.subject.display_name,
      },
      agent: { type: 'inline', spec: INLINE_SPEC },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
    const agent = await new SqliteAgentStore(db).createAgent({
      tenant_id: CREATOR.tenant_id,
      created_by_subject: { subject_id: 'agent-owner', subject_type: 'user', subject_display_name: 'Agent owner' },
      name: 'managed-agent',
      description: 'Test agent.',
      manifest: INLINE_SPEC,
      external_id: MANAGED_AGENT_EXTERNAL_ID,
    });
    await sessionStore.createSession({
      tenant_id: CREATOR.tenant_id,
      session_id: MANAGED_SESSION_ID,
      created_by_subject: {
        subject_id: CREATOR.subject.id,
        subject_type: CREATOR.subject.type,
        subject_display_name: CREATOR.subject.display_name,
      },
      agent: { type: 'reference', id: agent.id, name: agent.name },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function putFile(sessionId = SESSION_ID): Promise<string> {
    const { file_id } = await fileStore.put({
      tenant_id: CREATOR.tenant_id,
      session_id: sessionId,
      media_type: 'image/png',
      bytes: PNG_BYTES,
    });
    return file_id;
  }

  it('serves the creator the bytes with the stored media type, privately cached', async () => {
    const fileId = await putFile();
    const res = await app.request(`/${SESSION_ID}/files/${fileId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('serves a manager of the session’s named agent, and 404s another user without the grant', async () => {
    const fileId = await putFile(MANAGED_SESSION_ID);
    caller = OTHER_USER;
    expect((await app.request(`/${MANAGED_SESSION_ID}/files/${fileId}`)).status).toBe(404);
    authorizer = managerAuthorizer;
    const res = await app.request(`/${MANAGED_SESSION_ID}/files/${fileId}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('answers 404 to a manager of that agent in another tenant', async () => {
    const fileId = await putFile(MANAGED_SESSION_ID);
    caller = { ...OTHER_USER, tenant_id: 'other-tenant' };
    authorizer = managerAuthorizer;
    expect((await app.request(`/${MANAGED_SESSION_ID}/files/${fileId}`)).status).toBe(404);
  });

  it('answers 404 to a manager of that agent for an inline-agent session', async () => {
    const fileId = await putFile();
    caller = OTHER_USER;
    authorizer = managerAuthorizer;
    expect((await app.request(`/${SESSION_ID}/files/${fileId}`)).status).toBe(404);
  });

  it('answers 404 to another user of the same tenant', async () => {
    const fileId = await putFile();
    caller = OTHER_USER;
    const res = await app.request(`/${SESSION_ID}/files/${fileId}`);
    expect(res.status).toBe(404);
  });

  it('answers 404 to a caller from another tenant', async () => {
    const fileId = await putFile();
    caller = FOREIGN_TENANT;
    const res = await app.request(`/${SESSION_ID}/files/${fileId}`);
    expect(res.status).toBe(404);
  });

  it('answers the same 404 for a missing file, a missing session and a forbidden one', async () => {
    const fileId = await putFile();
    const missingFile = await app.request(`/${SESSION_ID}/files/${'0'.repeat(32)}`);
    const missingSession = await app.request(`/ses_missing/files/${fileId}`);
    caller = OTHER_USER;
    const forbidden = await app.request(`/${SESSION_ID}/files/${fileId}`);
    expect([missingFile.status, missingSession.status, forbidden.status]).toEqual([404, 404, 404]);
    const messages = await Promise.all([missingFile, forbidden].map(async res => JSON.stringify(await res.json())));
    expect(messages[0]).toContain('File not found');
    expect(messages[1]).toContain('File not found');
  });

  it('rejects a file id that is not one the store mints', async () => {
    const res = await app.request(`/${SESSION_ID}/files/..%2F..%2Fetc`);
    expect(res.status).toBe(400);
  });

  it('deleting the session removes its objects and rows', async () => {
    const fileIds = [await putFile(), await putFile()];
    const res = await app.request(`/${SESSION_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    for (const fileId of fileIds) {
      expect(await objects.get(`tenants/${CREATOR.tenant_id}/sessions/${SESSION_ID}/files/${fileId}`)).toBeUndefined();
    }
    const rows = await db.selectFrom('session_file').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('deleting the session also removes an object a racing put left after the first sweep', async () => {
    const orphanKey = `tenants/${CREATOR.tenant_id}/sessions/${SESSION_ID}/files/${'d'.repeat(32)}`;
    let sweeps = 0;
    routeFileStore = {
      put: input => fileStore.put(input),
      get: input => fileStore.get(input),
      deleteSession: async input => {
        await fileStore.deleteSession(input);
        sweeps += 1;
        if (sweeps === 1) {
          await objects.put({ key: orphanKey, media_type: 'image/png', bytes: PNG_BYTES });
        }
      },
    };
    const res = await app.request(`/${SESSION_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(sweeps).toBe(2);
    expect(await objects.get(orphanKey)).toBeUndefined();
  });

  it('still answers 204 when the sweep after the session is gone fails', async () => {
    let sweeps = 0;
    routeFileStore = {
      put: input => fileStore.put(input),
      get: input => fileStore.get(input),
      deleteSession: async input => {
        sweeps += 1;
        if (sweeps === 2) {
          throw new Error('object store down');
        }
        await fileStore.deleteSession(input);
      },
    };
    const res = await app.request(`/${SESSION_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await app.request(`/${SESSION_ID}/files/${'0'.repeat(32)}`)).status).toBe(404);
  });
});
