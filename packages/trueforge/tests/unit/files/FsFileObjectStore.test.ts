import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runFileStoreContractSuite } from '../../../../trueforge-core/tests/agent-session/store/fileStoreContractSuite';
import { FsFileObjectStore } from '../../../src/files/FsFileObjectStore';

describe('SessionFileStore over FsFileObjectStore (IFileStore contract)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'trueforge-files-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  runFileStoreContractSuite(() => new FsFileObjectStore(path.join(root, 'created-on-first-put')));
});

describe('FsFileObjectStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'trueforge-files-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a key that would leave its root', async () => {
    const store = new FsFileObjectStore(root);
    await expect(store.put({ key: '../outside', media_type: 'text/plain', bytes: Uint8Array.of(1) })).rejects.toThrow(
      'escapes its root',
    );
  });

  it('removes the directory of a deleted prefix instead of leaving it empty', async () => {
    const store = new FsFileObjectStore(root);
    await store.put({ key: 'tenants/t/sessions/s/files/f1', media_type: 'image/png', bytes: Uint8Array.of(1) });
    await store.deletePrefix('tenants/t/sessions/s/files/');
    expect(await readdir(path.join(root, 'tenants', 't', 'sessions', 's'))).toEqual([]);
  });

  it('deletes only the names that start with a partial prefix', async () => {
    const store = new FsFileObjectStore(root);
    await store.put({ key: 'dir/ab', media_type: 'text/plain', bytes: Uint8Array.of(1) });
    await store.put({ key: 'dir/ac', media_type: 'text/plain', bytes: Uint8Array.of(2) });
    await store.deletePrefix('dir/ab');
    expect(await store.get('dir/ab')).toBeUndefined();
    expect(await store.get('dir/ac')).toEqual(Uint8Array.of(2));
  });
});
