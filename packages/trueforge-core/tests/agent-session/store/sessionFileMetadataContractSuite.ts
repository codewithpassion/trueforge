import type { ISessionFileMetadataStore, SessionFileRecord } from '../../../src/agent-session/store/IFileStore';
import type { ISessionStore } from '../../../src/agent-session/store/ISessionStore';
import { makeAgentSpec } from '../testHelpers';

const TENANT = 't1';
const SESSION = 's1';

function record(overrides: Partial<SessionFileRecord> = {}): SessionFileRecord {
  return {
    file_id: 'a'.repeat(32),
    tenant_id: TENANT,
    session_id: SESSION,
    media_type: 'image/png',
    size_bytes: 1234,
    created_at: new Date('2026-09-23T01:02:03.456Z'),
    ...overrides,
  };
}

/** `session_file` rows over a database, beside the session store whose deletes cascade to them. */
export function runSessionFileMetadataContractSuite(
  createStores: () => { metadata: ISessionFileMetadataStore; sessionStore: ISessionStore },
) {
  let metadata: ISessionFileMetadataStore;
  let sessionStore: ISessionStore;

  async function seedSession({ tenant_id, session_id }: { tenant_id: string; session_id: string }) {
    await sessionStore.createSession({
      tenant_id,
      session_id,
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  }

  beforeEach(async () => {
    ({ metadata, sessionStore } = createStores());
    await seedSession({ tenant_id: TENANT, session_id: SESSION });
  });

  it('get returns the inserted row', async () => {
    await metadata.insert(record());
    expect(await metadata.get({ tenant_id: TENANT, session_id: SESSION, file_id: 'a'.repeat(32) })).toEqual(record());
  });

  it('get is scoped to the tenant, the session and the file', async () => {
    await seedSession({ tenant_id: TENANT, session_id: 's2' });
    await metadata.insert(record());
    const fileId = 'a'.repeat(32);
    expect(await metadata.get({ tenant_id: 'other-tenant', session_id: SESSION, file_id: fileId })).toBeUndefined();
    expect(await metadata.get({ tenant_id: TENANT, session_id: 's2', file_id: fileId })).toBeUndefined();
    expect(await metadata.get({ tenant_id: TENANT, session_id: SESSION, file_id: 'b'.repeat(32) })).toBeUndefined();
  });

  it('rejects a row for a session that does not exist', async () => {
    await expect(metadata.insert(record({ session_id: 'missing-session' }))).rejects.toThrow();
  });

  it('deleteSession removes only that session’s rows', async () => {
    await seedSession({ tenant_id: TENANT, session_id: 's2' });
    await metadata.insert(record());
    await metadata.insert(record({ file_id: 'b'.repeat(32) }));
    await metadata.insert(record({ session_id: 's2' }));
    await metadata.deleteSession({ tenant_id: TENANT, session_id: SESSION });
    expect(await metadata.get({ tenant_id: TENANT, session_id: SESSION, file_id: 'a'.repeat(32) })).toBeUndefined();
    expect(await metadata.get({ tenant_id: TENANT, session_id: SESSION, file_id: 'b'.repeat(32) })).toBeUndefined();
    expect(await metadata.get({ tenant_id: TENANT, session_id: 's2', file_id: 'a'.repeat(32) })).toEqual(
      record({ session_id: 's2' }),
    );
  });

  it('deleteSession ignores a tenant that does not own the session', async () => {
    await metadata.insert(record());
    await metadata.deleteSession({ tenant_id: 'other-tenant', session_id: SESSION });
    expect(await metadata.get({ tenant_id: TENANT, session_id: SESSION, file_id: 'a'.repeat(32) })).toBeDefined();
  });

  it('deleting the session deletes its rows', async () => {
    await metadata.insert(record());
    await sessionStore.deleteSession({ tenant_id: TENANT, session_id: SESSION });
    expect(await metadata.get({ tenant_id: TENANT, session_id: SESSION, file_id: 'a'.repeat(32) })).toBeUndefined();
  });
}
