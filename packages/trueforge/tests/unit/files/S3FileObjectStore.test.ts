import { createHash } from 'node:crypto';

import { runFileStoreContractSuite } from '../../../../trueforge-core/tests/agent-session/store/fileStoreContractSuite';
import { S3FileObjectStore } from '../../../src/files/S3FileObjectStore';

const ENDPOINT = 'https://s3.test';
const BUCKET = 'files';
/** Smaller than any real S3 page, so every multi-file delete walks the continuation tokens. */
const FAKE_PAGE_SIZE = 2;

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** An in-memory S3 bucket behind `fetch`: path-style objects, ListObjectsV2 and DeleteObjects. */
class FakeS3 {
  readonly objects = new Map<string, { bytes: Uint8Array; content_type: string | null }>();
  readonly requests: Request[] = [];

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    this.requests.push(request);
    if (request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ') !== true) {
      return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    }
    const url = new URL(request.url);
    const [bucket, ...keyParts] = url.pathname.slice(1).split('/');
    if (url.origin !== ENDPOINT || bucket !== BUCKET) {
      return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
    }
    const key = keyParts.map(decodeURIComponent).join('/');
    if (key === '' && request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      return this.#list(url.searchParams);
    }
    if (key === '' && request.method === 'POST' && url.searchParams.has('delete')) {
      return this.#deleteObjects(request);
    }
    if (request.method === 'PUT') {
      this.objects.set(key, {
        bytes: new Uint8Array(await request.arrayBuffer()),
        content_type: request.headers.get('content-type'),
      });
      return new Response(null, { status: 200 });
    }
    if (request.method === 'GET') {
      const object = this.objects.get(key);
      return object === undefined
        ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        : new Response(object.bytes.slice(), { status: 200 });
    }
    if (request.method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('unsupported', { status: 400 });
  };

  #list(params: URLSearchParams): Response {
    const prefix = params.get('prefix') ?? '';
    const pageSize = Math.min(Number(params.get('max-keys') ?? '1000'), FAKE_PAGE_SIZE);
    // Like S3's, the token names the last key listed, so deleting a page does not shift the next one.
    const after = params.get('continuation-token') ?? '';
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix) && key > after).sort();
    const page = keys.slice(0, pageSize);
    const truncated = pageSize < keys.length;
    const contents = page.map(key => `<Contents><Key>${escapeXml(key)}</Key></Contents>`).join('');
    const next = truncated ? `<NextContinuationToken>${escapeXml(page.at(-1) ?? '')}</NextContinuationToken>` : '';
    return new Response(
      `<ListBucketResult><IsTruncated>${String(truncated)}</IsTruncated>${contents}${next}</ListBucketResult>`,
    );
  }

  async #deleteObjects(request: Request): Promise<Response> {
    const body = await request.text();
    if (request.headers.get('content-md5') !== createHash('md5').update(body).digest('base64')) {
      return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 });
    }
    for (const match of body.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      const key = (match[1] ?? '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      this.objects.delete(key);
    }
    return new Response('<DeleteResult></DeleteResult>');
  }
}

function storeOver(s3: FakeS3): S3FileObjectStore {
  return new S3FileObjectStore({
    endpoint: `${ENDPOINT}/`,
    bucket: BUCKET,
    region: 'us-east-1',
    access_key_id: 'test-key',
    secret_access_key: 'test-secret',
    fetch: s3.fetch,
  });
}

describe('SessionFileStore over S3FileObjectStore (IFileStore contract)', () => {
  runFileStoreContractSuite(() => storeOver(new FakeS3()));
});

describe('S3FileObjectStore', () => {
  it('sends the media type as the object content type', async () => {
    const s3 = new FakeS3();
    await storeOver(s3).put({ key: 'a/b', media_type: 'image/jpeg', bytes: Uint8Array.of(1) });
    expect(s3.objects.get('a/b')?.content_type).toBe('image/jpeg');
  });

  it('deletes a prefix across listing pages and leaves other keys', async () => {
    const s3 = new FakeS3();
    const store = storeOver(s3);
    for (const name of ['1', '2', '3', '4', '5']) {
      await store.put({ key: `p/files/${name}`, media_type: 'text/plain', bytes: Uint8Array.of(1) });
    }
    await store.put({ key: 'p/filesx', media_type: 'text/plain', bytes: Uint8Array.of(1) });
    await store.deletePrefix('p/files/');
    expect([...s3.objects.keys()]).toEqual(['p/filesx']);
    const listings = s3.requests.filter(request => new URL(request.url).searchParams.get('list-type') === '2');
    expect(listings.length).toBeGreaterThan(1);
  });

  it('round-trips keys that need escaping in URLs and XML', async () => {
    const s3 = new FakeS3();
    const store = storeOver(s3);
    const key = 'tenants/a%2Fb/sessions/x&y<z>/files/f';
    await store.put({ key, media_type: 'text/plain', bytes: Uint8Array.of(7) });
    expect(await store.get(key)).toEqual(Uint8Array.of(7));
    await store.deletePrefix('tenants/a%2Fb/');
    expect(s3.objects.size).toBe(0);
  });

  it('fails every operation on a missing bucket instead of reading it as a missing file', async () => {
    const s3 = new FakeS3();
    const store = new S3FileObjectStore({
      endpoint: ENDPOINT,
      bucket: 'no-such-bucket',
      region: 'us-east-1',
      access_key_id: 'k',
      secret_access_key: 's',
      fetch: s3.fetch,
    });
    await expect(store.get('a/b')).rejects.toThrow('S3 GetObject failed with 404: <Error><Code>NoSuchBucket');
    await expect(store.put({ key: 'a/b', media_type: 'image/png', bytes: Uint8Array.of(1) })).rejects.toThrow(
      'NoSuchBucket',
    );
    await expect(store.deletePrefix('a/')).rejects.toThrow('NoSuchBucket');
  });

  it('reads a missing key as undefined', async () => {
    expect(await storeOver(new FakeS3()).get('absent')).toBeUndefined();
  });

  it('reports a failed request with its status', async () => {
    const store = new S3FileObjectStore({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      region: 'us-east-1',
      access_key_id: 'k',
      secret_access_key: 's',
      fetch: () => Promise.resolve(new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 })),
    });
    await expect(store.get('k')).rejects.toThrow('S3 GetObject failed with 503');
  });
});
