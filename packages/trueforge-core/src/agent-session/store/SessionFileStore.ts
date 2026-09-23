import type {
  GetFileInput,
  IFileObjectStore,
  IFileStore,
  ISessionFileMetadataStore,
  PutFileInput,
  PutFileResult,
  StoredFile,
} from './IFileStore';
import type { DeleteSessionInput } from './ISessionStore';

const FILE_ID_BYTES = 16;

/** File ids are 128 random bits as lowercase hex. */
export const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Raster images only: the read route serves the stored type, so nothing scriptable (SVG, HTML) goes in. */
const ALLOWED_MEDIA_TYPE = /^image\/(png|jpeg|webp|gif)$/;

function newFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(FILE_ID_BYTES));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Tenant and session ids are free-form, so each is percent-encoded with `.` escaped too: a segment
 * can then never hold `/` or be `.`/`..`, which keeps one session's prefix from covering another's
 * and keeps the filesystem store inside its root.
 */
function keySegment(value: string): string {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

/** `tenants/<tenant_id>/sessions/<session_id>/files/`; the trailing slash keeps `s1` from matching `s10`. */
function sessionFilesPrefix({ tenant_id, session_id }: DeleteSessionInput): string {
  return `tenants/${keySegment(tenant_id)}/sessions/${keySegment(session_id)}/files/`;
}

function sessionFileKey(input: GetFileInput): string {
  return `${sessionFilesPrefix(input)}${keySegment(input.file_id)}`;
}

/** Bytes in an object store, one `session_file` row per file. */
export class SessionFileStore implements IFileStore {
  readonly #objects: IFileObjectStore;
  readonly #metadata: ISessionFileMetadataStore;

  constructor({ objects, metadata }: { objects: IFileObjectStore; metadata: ISessionFileMetadataStore }) {
    this.#objects = objects;
    this.#metadata = metadata;
  }

  async put(input: PutFileInput): Promise<PutFileResult> {
    if (!ALLOWED_MEDIA_TYPE.test(input.media_type)) {
      throw new Error(
        `Unsupported session file media type ${JSON.stringify(input.media_type)}; allowed: image/png, image/jpeg, image/webp, image/gif`,
      );
    }
    const fileId = newFileId();
    const key = sessionFileKey({ tenant_id: input.tenant_id, session_id: input.session_id, file_id: fileId });
    const sizeBytes = input.bytes.byteLength;
    await this.#objects.put({ key, media_type: input.media_type, bytes: input.bytes });
    try {
      await this.#metadata.insert({
        file_id: fileId,
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        media_type: input.media_type,
        size_bytes: sizeBytes,
        created_at: new Date(),
      });
    } catch (error) {
      // Nothing reaches an object without its row (for example the session was deleted meanwhile),
      // so drop it; the insert failure is the one worth reporting.
      await this.#objects.delete(key).catch(() => undefined);
      throw error;
    }
    return { file_id: fileId, size_bytes: sizeBytes };
  }

  async get(input: GetFileInput): Promise<StoredFile | undefined> {
    const record = await this.#metadata.get(input);
    if (record === undefined) {
      return undefined;
    }
    const bytes = await this.#objects.get(sessionFileKey(input));
    return bytes === undefined ? undefined : { bytes, media_type: record.media_type };
  }

  /** Objects first: if that fails the rows remain, and a retry still finds everything to delete. */
  async deleteSession(input: DeleteSessionInput): Promise<void> {
    await this.#objects.deletePrefix(sessionFilesPrefix(input));
    await this.#metadata.deleteSession(input);
  }
}
