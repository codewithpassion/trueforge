import { sql, type Kysely } from 'kysely';

/**
 * Lets one turn owe a message to more than one conversation — mirrors
 * db/postgres/migrations/20260921_000001_delivery_notification_target.ts and
 * migrations/d1/0004_delivery_notification_target.sql.
 *
 * A notification rule posts a finished schedule run to a channel, and a second rule may post
 * the same run somewhere else, so "one delivery per turn" becomes "one per turn and
 * conversation". That also breaks the assumption that the conversation key names the session
 * the turn belongs to, which the retry sweep relied on, hence `session_external_id`.
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
    await sql`
      CREATE UNIQUE INDEX integration_delivery_target_uq
        ON integration_delivery (turn_id, conversation_key)
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
  });
}
