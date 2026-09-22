import { sql, type Kysely } from 'kysely';

/**
 * Integrations for SQLite — mirrors
 * db/postgres/migrations/20260918_000002_integration.ts and
 * migrations/d1/0002_integration.sql.
 *
 * SQLite differences: JSON documents are BLOB JSONB, timestamps are ISO TEXT,
 * tables are STRICT. No parent table is rebuilt here, so no `PRAGMA foreign_keys`
 * toggle is needed — the migration owns its own transaction because Kysely's
 * Migrator does not wrap SQLite migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE integration (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (length(type) <= 32),
        external_account_id TEXT NOT NULL,
        manifest BLOB NOT NULL,
        created_by_subject BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // One connection per channel account, so a re-connect updates instead of duplicating.
    await sql`
      CREATE UNIQUE INDEX integration_account_uq
        ON integration (tenant_id, type, external_account_id)
    `.execute(trx);

    await sql`
      CREATE INDEX integration_list_idx
        ON integration (tenant_id, created_at, id)
    `.execute(trx);

    await sql`
      CREATE TABLE integration_event (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        integration_id TEXT NOT NULL REFERENCES integration (id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // Replay and retry dedupe: one accepted row per channel event id.
    await sql`
      CREATE UNIQUE INDEX integration_event_uq
        ON integration_event (integration_id, event_id)
    `.execute(trx);

    // Drives the retention sweep.
    await sql`
      CREATE INDEX integration_event_received_at_idx
        ON integration_event (received_at)
    `.execute(trx);

    await sql`
      CREATE TABLE integration_delivery (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        integration_id TEXT NOT NULL REFERENCES integration (id) ON DELETE CASCADE,
        conversation_key TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (length(status) <= 16),
        attempts INTEGER NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // At most one delivery per turn — "reply once" expressed as a constraint.
    await sql`
      CREATE UNIQUE INDEX integration_delivery_turn_uq
        ON integration_delivery (turn_id)
    `.execute(trx);

    // Partial: the table is overwhelmingly terminal rows once a delivery settles. It covers
    // `sending` too, so a row stranded mid-post is still reachable by the retry sweep.
    await sql`
      CREATE INDEX integration_delivery_pending_idx
        ON integration_delivery (updated_at)
        WHERE status IN ('pending', 'sending')
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS integration_delivery`.execute(trx);
    await sql`DROP TABLE IF EXISTS integration_event`.execute(trx);
    await sql`DROP TABLE IF EXISTS integration`.execute(trx);
  });
}
