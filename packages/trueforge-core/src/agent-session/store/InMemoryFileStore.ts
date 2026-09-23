import type {
  GetFileInput,
  IFileObjectStore,
  IFileStore,
  ISessionFileMetadataStore,
  SessionFileRecord,
} from './IFileStore';
import type { DeleteSessionInput } from './ISessionStore';
import { SessionFileStore } from './SessionFileStore';

/** Process-local object store for tests and fixtures. */
export class InMemoryFileObjectStore implements IFileObjectStore {
  readonly #objects = new Map<string, Uint8Array>();

  put({ key, bytes }: { key: string; media_type: string; bytes: Uint8Array }): Promise<void> {
    this.#objects.set(key, bytes.slice());
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#objects.get(key)?.slice());
  }

  delete(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }

  deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.#objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.#objects.delete(key);
      }
    }
    return Promise.resolve();
  }
}

/** Process-local `session_file` rows for tests and fixtures. */
export class InMemorySessionFileMetadataStore implements ISessionFileMetadataStore {
  #records: SessionFileRecord[] = [];

  insert(record: SessionFileRecord): Promise<void> {
    this.#records.push({ ...record });
    return Promise.resolve();
  }

  get(input: GetFileInput): Promise<SessionFileRecord | undefined> {
    const record = this.#records.find(
      row => row.tenant_id === input.tenant_id && row.session_id === input.session_id && row.file_id === input.file_id,
    );
    return Promise.resolve(record === undefined ? undefined : { ...record });
  }

  deleteSession(input: DeleteSessionInput): Promise<void> {
    this.#records = this.#records.filter(
      row => row.tenant_id !== input.tenant_id || row.session_id !== input.session_id,
    );
    return Promise.resolve();
  }
}

/** A file store held in process memory, for tests and fixtures. */
export function createInMemoryFileStore(): IFileStore {
  return new SessionFileStore({
    objects: new InMemoryFileObjectStore(),
    metadata: new InMemorySessionFileMetadataStore(),
  });
}
