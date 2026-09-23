import { createHash } from 'node:crypto';

import type { IFileObjectStore } from '@truefoundry/trueforge-core/agent-session';
import { AwsClient } from 'aws4fetch';

/** S3 caps one DeleteObjects request at 1000 keys, the same as one ListObjectsV2 page. */
const DELETE_BATCH_SIZE = 1000;

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return XML_ENTITIES[name] ?? entity;
  });
}

function encodeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function xmlValues({ xml, tag }: { xml: string; tag: string }): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g')), match => decodeXml(match[1] ?? ''));
}

export interface S3FileObjectStoreOptions {
  /** Origin of the S3 API (AWS, R2 or MinIO); requests use path-style `<endpoint>/<bucket>/<key>`. */
  endpoint: string;
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  fetch: typeof fetch;
}

/** Any S3-compatible bucket, signed with SigV4 over `fetch`. */
export class S3FileObjectStore implements IFileObjectStore {
  readonly #client: AwsClient;
  readonly #bucketUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: S3FileObjectStoreOptions) {
    this.#client = new AwsClient({
      accessKeyId: options.access_key_id,
      secretAccessKey: options.secret_access_key,
      service: 's3',
      region: options.region,
    });
    this.#bucketUrl = `${options.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(options.bucket)}`;
    this.#fetch = options.fetch;
  }

  /**
   * Throws on every failure except a 404 naming a missing key, so a missing bucket or a misrouted
   * endpoint never reads as "no such file".
   */
  async #send({ url, init, operation }: { url: string; init: RequestInit; operation: string }): Promise<Response> {
    const response = await this.#fetch(await this.#client.sign(url, init));
    if (response.ok) {
      return response;
    }
    const body = await response.text().catch(() => '');
    if (response.status === 404 && body.includes('<Code>NoSuchKey</Code>')) {
      return new Response(null, { status: 404 });
    }
    throw new Error(`S3 ${operation} failed with ${String(response.status)}: ${body.slice(0, 500)}`);
  }

  #objectUrl(key: string): string {
    return `${this.#bucketUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put({ key, media_type, bytes }: { key: string; media_type: string; bytes: Uint8Array }): Promise<void> {
    await this.#send({
      url: this.#objectUrl(key),
      init: { method: 'PUT', body: bytes, headers: { 'Content-Type': media_type } },
      operation: 'PutObject',
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.#send({ url: this.#objectUrl(key), init: { method: 'GET' }, operation: 'GetObject' });
    if (response.status === 404) {
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.#send({ url: this.#objectUrl(key), init: { method: 'DELETE' }, operation: 'DeleteObject' });
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const query = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': String(DELETE_BATCH_SIZE) });
      if (continuationToken !== undefined) {
        query.set('continuation-token', continuationToken);
      }
      const response = await this.#send({
        url: `${this.#bucketUrl}?${query.toString()}`,
        init: { method: 'GET' },
        operation: 'ListObjectsV2',
      });
      const listing = await response.text();
      await this.#deleteKeys(xmlValues({ xml: listing, tag: 'Key' }));
      continuationToken =
        xmlValues({ xml: listing, tag: 'IsTruncated' })[0] === 'true'
          ? xmlValues({ xml: listing, tag: 'NextContinuationToken' })[0]
          : undefined;
    } while (continuationToken !== undefined);
  }

  async #deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const objects = keys.map(key => `<Object><Key>${encodeXml(key)}</Key></Object>`).join('');
    const body = `<Delete><Quiet>true</Quiet>${objects}</Delete>`;
    const response = await this.#send({
      url: `${this.#bucketUrl}?delete`,
      init: {
        method: 'POST',
        body,
        // S3 refuses a multi-object delete without a body checksum.
        headers: { 'Content-MD5': createHash('md5').update(body).digest('base64'), 'Content-Type': 'application/xml' },
      },
      operation: 'DeleteObjects',
    });
    // A 200 still lists the keys it could not delete.
    const result = await response.text();
    if (response.status === 404 || result.includes('<Error>')) {
      throw new Error(`S3 DeleteObjects failed: ${result.slice(0, 500)}`);
    }
  }
}
