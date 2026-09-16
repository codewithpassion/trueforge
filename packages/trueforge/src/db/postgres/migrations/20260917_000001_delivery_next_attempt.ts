import { sql, type Kysely } from 'kysely';

/**
 * Gives the outbox an explicit due time — mirrors
 * db/sqlite/migrations/20260917_000001_delivery_next_attempt.ts and
 * migrations/d1/0003_delivery_next_attempt.sql.
 *
 * `updated_at` was standing in for two different waits: a `pending` row's backoff and the
 * timeout on a `sending` row. One column the writer sets means the sweep reads due rows in
 * due order, so a long wait can no longer crowd out a short one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await db.schema
    .alterTable('integration_delivery')
    // Backfilled from `updated_at`, which is exactly what the old due rule read.
    .addColumn('next_attempt_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`UPDATE integration_delivery SET next_attempt_at = updated_at`.execute(db);

  await sql`DROP INDEX IF EXISTS integration_delivery_pending_idx`.execute(db);
  await sql`
    CREATE INDEX integration_delivery_due_idx
      ON integration_delivery (next_attempt_at)
      WHERE status IN ('pending', 'sending')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await sql`DROP INDEX IF EXISTS integration_delivery_due_idx`.execute(db);
  await sql`
    CREATE INDEX integration_delivery_pending_idx
      ON integration_delivery (updated_at)
      WHERE status IN ('pending', 'sending')
  `.execute(db);
  await db.schema.alterTable('integration_delivery').dropColumn('next_attempt_at').execute();
}
