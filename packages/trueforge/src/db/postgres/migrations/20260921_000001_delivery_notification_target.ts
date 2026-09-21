import { sql, type Kysely } from 'kysely';

/**
 * Lets one turn owe a message to more than one conversation — mirrors
 * db/sqlite/migrations/20260921_000001_delivery_notification_target.ts and
 * migrations/d1/0004_delivery_notification_target.sql.
 *
 * A notification rule posts a finished schedule run to a channel, and a second rule may post
 * the same run somewhere else, so "one delivery per turn" becomes "one per turn and
 * conversation". That also breaks the assumption that the conversation key names the session
 * the turn belongs to, which the retry sweep relied on, hence `session_external_id`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  // Every existing row is an integration conversation, whose key is its session's external id
  // verbatim: only keys over 128 characters are hashed, and no channel key reaches that.
  await sql`
    ALTER TABLE integration_delivery
      ADD COLUMN session_external_id text NOT NULL DEFAULT ''
  `.execute(db);
  await sql`UPDATE integration_delivery SET session_external_id = conversation_key`.execute(db);

  await sql`DROP INDEX IF EXISTS integration_delivery_turn_uq`.execute(db);
  await sql`
    CREATE UNIQUE INDEX integration_delivery_target_uq
      ON integration_delivery (turn_id, conversation_key)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`DROP INDEX IF EXISTS integration_delivery_target_uq`.execute(db);
  await sql`
    CREATE UNIQUE INDEX integration_delivery_turn_uq
      ON integration_delivery (turn_id)
  `.execute(db);
  await sql`ALTER TABLE integration_delivery DROP COLUMN session_external_id`.execute(db);
}
