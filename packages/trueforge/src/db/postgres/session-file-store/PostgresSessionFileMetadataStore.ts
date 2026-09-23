import type {
  DeleteSessionInput,
  GetFileInput,
  ISessionFileMetadataStore,
  SessionFileRecord,
} from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import type { Database } from '../types';

export class PostgresSessionFileMetadataStore implements ISessionFileMetadataStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async insert(record: SessionFileRecord): Promise<void> {
    await this.#db.insertInto('session_file').values(record).execute();
  }

  async get(input: GetFileInput): Promise<SessionFileRecord | undefined> {
    return this.#db
      .selectFrom('session_file')
      .selectAll()
      .where('session_id', '=', input.session_id)
      .where('file_id', '=', input.file_id)
      .where('tenant_id', '=', input.tenant_id)
      .executeTakeFirst();
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    await this.#db
      .deleteFrom('session_file')
      .where('session_id', '=', input.session_id)
      .where('tenant_id', '=', input.tenant_id)
      .execute();
  }
}
