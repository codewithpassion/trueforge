import type {
  DeleteSessionInput,
  GetFileInput,
  ISessionFileMetadataStore,
  SessionFileRecord,
} from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import type { Database } from '../types';

/** `session_file` on better-sqlite3 and D1; each method is one statement, so no batch is needed. */
export class SqliteSessionFileMetadataStore implements ISessionFileMetadataStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async insert(record: SessionFileRecord): Promise<void> {
    await this.#db
      .insertInto('session_file')
      .values({
        session_id: record.session_id,
        file_id: record.file_id,
        tenant_id: record.tenant_id,
        media_type: record.media_type,
        size_bytes: record.size_bytes,
        created_at: record.created_at.toISOString(),
      })
      .execute();
  }

  async get(input: GetFileInput): Promise<SessionFileRecord | undefined> {
    const row = await this.#db
      .selectFrom('session_file')
      .selectAll()
      .where('session_id', '=', input.session_id)
      .where('file_id', '=', input.file_id)
      .where('tenant_id', '=', input.tenant_id)
      .executeTakeFirst();
    return row === undefined ? undefined : { ...row, created_at: new Date(row.created_at) };
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    await this.#db
      .deleteFrom('session_file')
      .where('session_id', '=', input.session_id)
      .where('tenant_id', '=', input.tenant_id)
      .execute();
  }
}
