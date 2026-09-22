import { sql, type Kysely } from 'kysely';

/**
 * Gives the outbox an explicit due time for SQLite — mirrors
 * db/postgres/migrations/20260918_000003_delivery_next_attempt.ts and
 * migrations/d1/0003_delivery_next_attempt.sql.
 *
 * `updated_at` was standing in for two different waits: a `pending` row's backoff and the
 * timeout on a `sending` row. One column the writer sets means the sweep reads due rows in
 * due order, so a long wait can no longer crowd out a short one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    // Backfilled from `updated_at`, which is exactly what the old due rule read.
    await sql`
      ALTER TABLE integration_delivery
        ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT ''
    `.execute(trx);
    await sql`UPDATE integration_delivery SET next_attempt_at = updated_at`.execute(trx);

    await sql`DROP INDEX IF EXISTS integration_delivery_pending_idx`.execute(trx);
    await sql`
      CREATE INDEX integration_delivery_due_idx
        ON integration_delivery (next_attempt_at)
        WHERE status IN ('pending', 'sending')
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP INDEX IF EXISTS integration_delivery_due_idx`.execute(trx);
    await sql`
      CREATE INDEX integration_delivery_pending_idx
        ON integration_delivery (updated_at)
        WHERE status IN ('pending', 'sending')
    `.execute(trx);
    await sql`ALTER TABLE integration_delivery DROP COLUMN next_attempt_at`.execute(trx);
  });
}
