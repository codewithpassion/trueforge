import type { IFileObjectStore, IFileStore } from '../../../src/agent-session/store/IFileStore';
import { InMemorySessionFileMetadataStore } from '../../../src/agent-session/store/InMemoryFileStore';
import { FILE_ID_PATTERN, SessionFileStore } from '../../../src/agent-session/store/SessionFileStore';

const TENANT = 't1';
const SESSION = 's1';
const ALL_BYTE_VALUES = Uint8Array.from({ length: 256 }, (_, index) => index);

function mustGet<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

/**
 * `IFileStore` contract, run as `SessionFileStore` over each object backend. The backend is also
 * inspected directly, so "deleted" means the bytes are gone, not only the row.
 */
export function runFileStoreContractSuite(createObjects: () => IFileObjectStore | Promise<IFileObjectStore>) {
  let objects: IFileObjectStore;
  let store: IFileStore;

  beforeEach(async () => {
    objects = await createObjects();
    store = new SessionFileStore({ objects, metadata: new InMemorySessionFileMetadataStore() });
  });

  function put(input: { tenant_id?: string; session_id?: string; bytes?: Uint8Array; media_type?: string } = {}) {
    return store.put({
      tenant_id: input.tenant_id ?? TENANT,
      session_id: input.session_id ?? SESSION,
      media_type: input.media_type ?? 'image/png',
      bytes: input.bytes ?? ALL_BYTE_VALUES,
    });
  }

  it('put returns an opaque file id and the byte count', async () => {
    const result = await put();
    expect(result.file_id).toMatch(FILE_ID_PATTERN);
    expect(result.size_bytes).toBe(256);
  });

  it('get returns the bytes and media type that were put', async () => {
    const { file_id } = await put({ media_type: 'image/jpeg' });
    const file = mustGet(await store.get({ tenant_id: TENANT, session_id: SESSION, file_id }), 'file');
    expect(file.media_type).toBe('image/jpeg');
    expect(Array.from(file.bytes)).toEqual(Array.from(ALL_BYTE_VALUES));
  });

  it('stores an empty file', async () => {
    const { file_id, size_bytes } = await put({ bytes: new Uint8Array(0) });
    expect(size_bytes).toBe(0);
    const file = mustGet(await store.get({ tenant_id: TENANT, session_id: SESSION, file_id }), 'file');
    expect(file.bytes.byteLength).toBe(0);
  });

  it('put mints a distinct id per file', async () => {
    const first = await put({ bytes: Uint8Array.of(1) });
    const second = await put({ bytes: Uint8Array.of(2) });
    expect(first.file_id).not.toBe(second.file_id);
    const got = await store.get({ tenant_id: TENANT, session_id: SESSION, file_id: first.file_id });
    expect(Array.from(mustGet(got, 'first').bytes)).toEqual([1]);
  });

  it('keeps the object under tenants/<tenant_id>/sessions/<session_id>/files/<file_id>', async () => {
    const { file_id } = await put();
    const bytes = await objects.get(`tenants/${TENANT}/sessions/${SESSION}/files/${file_id}`);
    expect(bytes?.byteLength).toBe(256);
  });

  it('get is undefined for an unknown file', async () => {
    await put();
    expect(await store.get({ tenant_id: TENANT, session_id: SESSION, file_id: '0'.repeat(32) })).toBeUndefined();
  });

  it('get is scoped to the tenant and the session', async () => {
    const { file_id } = await put();
    expect(await store.get({ tenant_id: 'other-tenant', session_id: SESSION, file_id })).toBeUndefined();
    expect(await store.get({ tenant_id: TENANT, session_id: 'other-session', file_id })).toBeUndefined();
  });

  it('deleteSession removes every file of the session and its objects', async () => {
    const first = await put();
    const second = await put();
    await store.deleteSession({ tenant_id: TENANT, session_id: SESSION });
    for (const { file_id } of [first, second]) {
      expect(await store.get({ tenant_id: TENANT, session_id: SESSION, file_id })).toBeUndefined();
      expect(await objects.get(`tenants/${TENANT}/sessions/${SESSION}/files/${file_id}`)).toBeUndefined();
    }
  });

  it('deleteSession leaves other sessions, a session whose id extends this one, and other tenants', async () => {
    await put();
    const longer = await put({ session_id: `${SESSION}0` });
    const otherTenant = await put({ tenant_id: 'other-tenant' });
    await store.deleteSession({ tenant_id: TENANT, session_id: SESSION });
    expect(await store.get({ tenant_id: TENANT, session_id: `${SESSION}0`, file_id: longer.file_id })).toBeDefined();
    expect(
      await store.get({ tenant_id: 'other-tenant', session_id: SESSION, file_id: otherTenant.file_id }),
    ).toBeDefined();
  });

  it('keeps ids with slashes and dots inside their own session', async () => {
    const tricky = await put({ tenant_id: 'a/b', session_id: '../s1/files' });
    const plain = await put({ tenant_id: 'a', session_id: 'b' });
    await store.deleteSession({ tenant_id: 'a', session_id: 'b' });
    await store.deleteSession({ tenant_id: 'a/b', session_id: '..' });
    expect(await store.get({ tenant_id: 'a', session_id: 'b', file_id: plain.file_id })).toBeUndefined();
    const file = await store.get({ tenant_id: 'a/b', session_id: '../s1/files', file_id: tricky.file_id });
    expect(file?.bytes.byteLength).toBe(256);
  });

  it('deleteSession is a no-op for a session without files and can repeat', async () => {
    await store.deleteSession({ tenant_id: TENANT, session_id: 'no-files' });
    const { file_id } = await put();
    await store.deleteSession({ tenant_id: TENANT, session_id: SESSION });
    await store.deleteSession({ tenant_id: TENANT, session_id: SESSION });
    expect(await store.get({ tenant_id: TENANT, session_id: SESSION, file_id })).toBeUndefined();
  });

  it('put leaves no object behind when the row cannot be written', async () => {
    const rowFailure = new Error('session is gone');
    const putKeys: string[] = [];
    const failing = new SessionFileStore({
      objects: {
        put: input => {
          putKeys.push(input.key);
          return objects.put(input);
        },
        get: key => objects.get(key),
        delete: key => objects.delete(key),
        deletePrefix: prefix => objects.deletePrefix(prefix),
      },
      metadata: {
        insert: () => Promise.reject(rowFailure),
        get: () => Promise.resolve(undefined),
        deleteSession: () => Promise.resolve(),
      },
    });
    await expect(
      failing.put({ tenant_id: TENANT, session_id: SESSION, media_type: 'image/png', bytes: ALL_BYTE_VALUES }),
    ).rejects.toBe(rowFailure);
    expect(putKeys).toHaveLength(1);
    expect(await objects.get(mustGet(putKeys[0], 'put key'))).toBeUndefined();
  });
}
