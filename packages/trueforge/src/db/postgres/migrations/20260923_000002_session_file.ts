import { sql, type Kysely } from 'kysely';

/**
 * Metadata for files a session produced; the bytes live in the file store. Mirrors
 * db/sqlite/migrations/20260923_000002_session_file.ts and migrations/d1/0009_session_file.sql.
 * Rows go with their session through the cascade.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await db.schema
    .createTable('session_file')
    .addColumn('session_id', 'text', col => col.notNull())
    .addColumn('file_id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('media_type', 'text', col => col.notNull())
    .addColumn('size_bytes', 'integer', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('session_file_pkey', ['session_id', 'file_id'])
    .addForeignKeyConstraint('session_file_session_fkey', ['session_id'], 'session', ['session_id'], fk =>
      fk.onDelete('cascade'),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('session_file').ifExists().execute();
}
