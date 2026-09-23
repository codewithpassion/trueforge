export interface StoredFile {
  bytes: Uint8Array;
  media_type: string;
}

/** One session's files, already scoped to its tenant and session. Files live until the session is deleted. */
export interface SessionFiles {
  put(input: { media_type: string; bytes: Uint8Array }): Promise<{ file_id: string }>;
  /** Undefined when the session has no such file. */
  get(file_id: string): Promise<StoredFile | undefined>;
}
