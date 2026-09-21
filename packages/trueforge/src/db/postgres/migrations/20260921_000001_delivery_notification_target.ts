import { sql, type Kysely } from 'kysely';

/**
 * Lets one turn owe a message to more than one conversation — mirrors
 * db/sqlite/migrations/20260921_000001_delivery_notification_target.ts and
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
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  // Every existing row is an integration conversation, whose key is its session's external id
  // verbatim: only keys over 128 characters are hashed, and no channel key reaches that.
  await sql`
    ALTER TABLE integration_delivery
      ADD COLUMN session_external_id text NOT NULL DEFAULT ''
  `.execute(db);
  await sql`UPDATE integration_delivery SET session_external_id = conversation_key`.execute(db);

  await sql`DROP INDEX IF EXISTS integration_delivery_turn_uq`.execute(db);
  // Two integrations on one workspace can both hold a rule for the same channel, and each owes
  // its own post, so the integration is part of what makes a delivery unique.
  await sql`
    CREATE UNIQUE INDEX integration_delivery_target_uq
      ON integration_delivery (integration_id, turn_id, conversation_key)
  `.execute(db);

  // Who settled a held turn, kept apart from `integration_event` because that log is pruned at
  // 24 hours and an audit record must outlive it.
  await db.schema
    .createTable('integration_decision')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('integration_id', 'text', col => col.notNull().references('integration.id').onDelete('cascade'))
    .addColumn('turn_id', 'text', col => col.notNull())
    .addColumn('session_id', 'text', col => col.notNull())
    .addColumn('decided_by_id', 'text', col => col.notNull())
    .addColumn('decided_by_display_name', 'text', col => col.notNull())
    .addColumn('decision', sql`varchar(16)`, col => col.notNull())
    .addColumn('decided_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('integration_decision_pkey', ['id'])
    .execute();

  // One decision per held turn, matching the guarded resume row that admits one settler.
  await db.schema
    .createIndex('integration_decision_turn_uq')
    .on('integration_decision')
    .columns(['integration_id', 'turn_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('integration_decision_list_idx')
    .on('integration_decision')
    .columns(['tenant_id', 'integration_id', 'decided_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`DROP INDEX IF EXISTS integration_delivery_target_uq`.execute(db);
  await sql`
    CREATE UNIQUE INDEX integration_delivery_turn_uq
      ON integration_delivery (turn_id)
  `.execute(db);
  await sql`ALTER TABLE integration_delivery DROP COLUMN session_external_id`.execute(db);
  await db.schema.dropTable('integration_decision').ifExists().cascade().execute();
}
