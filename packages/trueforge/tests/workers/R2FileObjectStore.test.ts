import { env } from 'cloudflare:workers';

import { runFileStoreContractSuite } from '../../../trueforge-core/tests/agent-session/store/fileStoreContractSuite';
import { R2FileObjectStore } from '../../src/workers/R2FileObjectStore';

describe('SessionFileStore over R2FileObjectStore (IFileStore contract)', () => {
  runFileStoreContractSuite(async () => {
    const objects = new R2FileObjectStore(env.FILES);
    // The bucket outlives a test, so each one starts from an empty bucket.
    await objects.deletePrefix('');
    return objects;
  });
});

describe('R2FileObjectStore', () => {
  it('records the media type on the object', async () => {
    await new R2FileObjectStore(env.FILES).put({ key: 'media/a', media_type: 'image/jpeg', bytes: Uint8Array.of(1) });
    const head = await env.FILES.head('media/a');
    expect(head?.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('deletes a prefix holding more objects than one listing returns', async () => {
    const store = new R2FileObjectStore(env.FILES);
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) =>
        store.put({ key: `many/files/${String(index)}`, media_type: 'text/plain', bytes: Uint8Array.of(1) }),
      ),
    );
    await store.put({ key: 'many/other', media_type: 'text/plain', bytes: Uint8Array.of(1) });
    await store.deletePrefix('many/files/');
    const left = await env.FILES.list({ prefix: 'many/' });
    expect(left.objects.map(object => object.key)).toEqual(['many/other']);
  });
});
