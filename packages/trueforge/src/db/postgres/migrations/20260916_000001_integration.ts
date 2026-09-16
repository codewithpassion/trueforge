import { sql, type Kysely } from 'kysely';

/**
 * Integrations: `integration` + `integration_event` + `integration_delivery`.
 *
 * - `integration`: immutable application-generated `id` (ULID) as PK. The channel
 *   connection lives in Zod-validated `manifest` jsonb (same pattern as `schedule`),
 *   and `external_account_id` lifts the channel-side account out of it so one
 *   workspace can only be connected once per tenant.
 * - `integration_event`: accepted inbound event ids. The unique index is what makes a
 *   channel retry idempotent instead of a second turn. Rows are pruned on a retention
 *   sweep, which `integration_event_received_at_idx` drives.
 * - `integration_delivery`: the outbox. `integration_delivery_turn_uq` enforces AT MOST
 *   ONE delivery per turn, so a re-run of the completion hook cannot double-post.
 *   `integration_delivery_pending_idx` is PARTIAL on `status = 'pending'` because the
 *   table is overwhelmingly settled rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await db.schema
    .createTable('integration')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('type', sql`varchar(32)`, col => col.notNull())
    .addColumn('external_account_id', 'text', col => col.notNull())
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('created_by_subject', 'jsonb', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('integration_pkey', ['id'])
    .execute();

  await db.schema
    .createIndex('integration_account_uq')
    .on('integration')
    .columns(['tenant_id', 'type', 'external_account_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('integration_list_idx')
    .on('integration')
    .columns(['tenant_id', 'created_at', 'id'])
    .execute();

  await db.schema
    .createTable('integration_event')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('integration_id', 'text', col => col.notNull().references('integration.id').onDelete('cascade'))
    .addColumn('event_id', 'text', col => col.notNull())
    .addColumn('received_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('integration_event_pkey', ['id'])
    .execute();

  await db.schema
    .createIndex('integration_event_uq')
    .on('integration_event')
    .columns(['integration_id', 'event_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('integration_event_received_at_idx')
    .on('integration_event')
    .columns(['received_at'])
    .execute();

  await db.schema
    .createTable('integration_delivery')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('integration_id', 'text', col => col.notNull().references('integration.id').onDelete('cascade'))
    .addColumn('conversation_key', 'text', col => col.notNull())
    .addColumn('turn_id', 'text', col => col.notNull())
    .addColumn('status', sql`varchar(16)`, col => col.notNull())
    .addColumn('attempts', 'integer', col => col.notNull())
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('integration_delivery_pkey', ['id'])
    .execute();

  // A delivery row takes one or two small bounded updates in its life; leave HOT headroom.
  await sql`ALTER TABLE integration_delivery SET (fillfactor = 85)`.execute(db);

  await db.schema
    .createIndex('integration_delivery_turn_uq')
    .on('integration_delivery')
    .columns(['turn_id'])
    .unique()
    .execute();

  await sql`
    CREATE INDEX integration_delivery_pending_idx
      ON integration_delivery (updated_at)
      WHERE status = 'pending'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('integration_delivery').ifExists().cascade().execute();
  await db.schema.dropTable('integration_event').ifExists().cascade().execute();
  await db.schema.dropTable('integration').ifExists().cascade().execute();
}
