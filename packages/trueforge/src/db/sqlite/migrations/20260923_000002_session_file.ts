import { sql, type Kysely } from 'kysely';

/**
 * Metadata for files a session produced; the bytes live in the file store. Mirrors
 * db/postgres/migrations/20260923_000002_session_file.ts and migrations/d1/0009_session_file.sql.
 * Rows go with their session through the cascade. Kysely does not wrap SQLite migrations, so this
 * one owns its transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE session_file (
        session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, file_id)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS session_file`.execute(trx);
  });
}
