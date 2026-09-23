import {
  SessionFileStore,
  type IFileObjectStore,
  type IFileStore,
  type ISessionFileMetadataStore,
} from '@truefoundry/trueforge-core/agent-session';

/** R2 lists and deletes at most 1000 keys per call. */
const R2_PAGE_SIZE = 1000;

/** The `FILES` R2 binding. */
export class R2FileObjectStore implements IFileObjectStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async put({ key, media_type, bytes }: { key: string; media_type: string; bytes: Uint8Array }): Promise<void> {
    await this.#bucket.put(key, bytes, { httpMetadata: { contentType: media_type } });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.#bucket.get(key);
    return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.#bucket.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const listing = await this.#bucket.list({
        prefix,
        limit: R2_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (listing.objects.length > 0) {
        await this.#bucket.delete(listing.objects.map(object => object.key));
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor !== undefined);
  }
}

/** Session files on Workers: bytes in the `FILES` bucket, one D1 row each. */
export function createWorkersFileStore({
  bucket,
  metadata,
}: {
  bucket: R2Bucket;
  metadata: ISessionFileMetadataStore;
}): IFileStore {
  return new SessionFileStore({ objects: new R2FileObjectStore(bucket), metadata });
}
