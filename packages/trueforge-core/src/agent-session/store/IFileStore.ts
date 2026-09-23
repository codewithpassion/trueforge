import type { DeleteSessionInput } from './ISessionStore';

export interface PutFileInput {
  tenant_id: string;
  session_id: string;
  media_type: string;
  bytes: Uint8Array;
}

export interface PutFileResult {
  file_id: string;
  size_bytes: number;
}

export interface GetFileInput {
  tenant_id: string;
  session_id: string;
  file_id: string;
}

export interface StoredFile {
  bytes: Uint8Array;
  media_type: string;
}

/**
 * Files a session produced (for example tool-result screenshots), kept out of session history.
 * A file lives until its session is deleted.
 */
export interface IFileStore {
  /** Rejects any media type other than image/png, image/jpeg, image/webp and image/gif. */
  put(input: PutFileInput): Promise<PutFileResult>;
  /** Undefined when the file does not exist in that tenant's session. */
  get(input: GetFileInput): Promise<StoredFile | undefined>;
  /** Removes every file of the session; a session without files is a no-op. */
  deleteSession(input: DeleteSessionInput): Promise<void>;
}

/** One `session_file` row. */
export interface SessionFileRecord {
  file_id: string;
  tenant_id: string;
  session_id: string;
  media_type: string;
  size_bytes: number;
  created_at: Date;
}

/** The `session_file` table. Rows also go when their session row is deleted. */
export interface ISessionFileMetadataStore {
  insert(record: SessionFileRecord): Promise<void>;
  get(input: GetFileInput): Promise<SessionFileRecord | undefined>;
  deleteSession(input: DeleteSessionInput): Promise<void>;
}

/** Byte storage under opaque keys (R2, S3, a local directory). */
export interface IFileObjectStore {
  put(input: { key: string; media_type: string; bytes: Uint8Array }): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
}
