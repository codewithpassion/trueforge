import { createInMemoryFileStore, InMemoryFileObjectStore } from '../../../src/agent-session/store/InMemoryFileStore';
import { scopeFileStore } from '../../../src/agent-session/store/SessionFileStore';
import { runFileStoreContractSuite } from './fileStoreContractSuite';

describe('SessionFileStore over InMemoryFileObjectStore (IFileStore contract)', () => {
  runFileStoreContractSuite(() => new InMemoryFileObjectStore());
});

describe('scopeFileStore', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('reads back what its own session stored', async () => {
    const fileStore = createInMemoryFileStore();
    const files = scopeFileStore({ fileStore, tenant_id: 't1', session_id: 's1' });

    const { file_id } = await files.put({ media_type: 'image/png', bytes });

    expect(await files.get(file_id)).toEqual({ bytes, media_type: 'image/png' });
    expect(await fileStore.get({ tenant_id: 't1', session_id: 's1', file_id })).toEqual({
      bytes,
      media_type: 'image/png',
    });
  });

  it('does not see another session or tenant file with the same id', async () => {
    const fileStore = createInMemoryFileStore();
    const { file_id } = await scopeFileStore({ fileStore, tenant_id: 't1', session_id: 's1' }).put({
      media_type: 'image/png',
      bytes,
    });

    expect(await scopeFileStore({ fileStore, tenant_id: 't1', session_id: 's2' }).get(file_id)).toBeUndefined();
    expect(await scopeFileStore({ fileStore, tenant_id: 't2', session_id: 's1' }).get(file_id)).toBeUndefined();
  });
});
