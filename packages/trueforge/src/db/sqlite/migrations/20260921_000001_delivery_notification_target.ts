import { sql, type Kysely } from 'kysely';

/**
 * Lets one turn owe a message to more than one conversation — mirrors
 * db/postgres/migrations/20260921_000001_delivery_notification_target.ts and
 * migrations/d1/0004_delivery_notification_target.sql.
 *
 * A notification rule posts a finished schedule run to a channel, and a second rule may post
 * the same run somewhere else, so "one delivery per turn" becomes "one per integration, turn
 * and conversation". That also breaks the assumption that the conversation key names the
 * session the turn belongs to, which the retry sweep relied on, hence `session_external_id`.
 *
 * `integration_decision` lands here too: who approved a tool call has to outlive the 24-hour
 * dedupe log and must not sit anywhere a tenant user can rewrite it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    // Every existing row is an integration conversation, whose key is its session's external
    // id verbatim: only keys over 128 characters are hashed, and no channel key reaches that.
    await sql`
      ALTER TABLE integration_delivery
        ADD COLUMN session_external_id TEXT NOT NULL DEFAULT ''
    `.execute(trx);
    await sql`UPDATE integration_delivery SET session_external_id = conversation_key`.execute(trx);

    await sql`DROP INDEX IF EXISTS integration_delivery_turn_uq`.execute(trx);
    // Two integrations on one workspace can both hold a rule for the same channel, and each
    // owes its own post, so the integration is part of what makes a delivery unique.
    await sql`
      CREATE UNIQUE INDEX integration_delivery_target_uq
        ON integration_delivery (integration_id, turn_id, conversation_key)
    `.execute(trx);

    // Who settled a held turn, kept apart from `integration_event` because that log is pruned
    // at 24 hours and an audit record must outlive it.
    await sql`
      CREATE TABLE integration_decision (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        integration_id TEXT NOT NULL REFERENCES integration (id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        decided_by_id TEXT NOT NULL,
        decided_by_display_name TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (length(decision) <= 16),
        decided_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // One decision per held turn, matching the guarded resume row that admits one settler.
    await sql`
      CREATE UNIQUE INDEX integration_decision_turn_uq
        ON integration_decision (integration_id, turn_id)
    `.execute(trx);

    await sql`
      CREATE INDEX integration_decision_list_idx
        ON integration_decision (tenant_id, integration_id, decided_at)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP INDEX IF EXISTS integration_delivery_target_uq`.execute(trx);
    await sql`
      CREATE UNIQUE INDEX integration_delivery_turn_uq
        ON integration_delivery (turn_id)
    `.execute(trx);
    await sql`ALTER TABLE integration_delivery DROP COLUMN session_external_id`.execute(trx);
    await sql`DROP TABLE IF EXISTS integration_decision`.execute(trx);
  });
}
