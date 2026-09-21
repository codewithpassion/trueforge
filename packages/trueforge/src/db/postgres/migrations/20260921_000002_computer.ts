import { sql, type Kysely } from 'kysely';

/**
 * Remote computers — mirrors
 * db/sqlite/migrations/20260921_000002_computer.ts and
 * migrations/d1/0005_computer.sql.
 *
 * - `computer`: immutable application-generated `id` (ULID) as PK. `credential_hash` is the
 *   sha256 the relay authenticates against, so it is unique across the table and NULL until
 *   the machine enrolls. `capabilities` holds what `hello` reported.
 * - `computer_enrollment`: single-use codes keyed by their sha256. `used_at` burns one.
 * - `computer_agent_access`: the per-computer agent allowlist, indexed by agent so deleting
 *   an agent can refuse while a grant stands.
 * - `computer_audit`: what ran. Ids are ULIDs, so `computer_audit_list_idx` with `id DESC`
 *   serves both the newest-first listing and its `before_id` paging.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await db.schema
    .createTable('computer')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('name', sql`varchar(128)`, col => col.notNull())
    .addColumn('owner_subject', 'text', col => col.notNull())
    .addColumn('status', sql`varchar(16)`, col => col.notNull())
    .addColumn('credential_hash', 'text')
    .addColumn('hostname', 'text')
    .addColumn('os', 'text')
    .addColumn('arch', 'text')
    .addColumn('agent_version', 'text')
    .addColumn('capabilities', 'jsonb')
    .addColumn('run_as_user', 'text')
    .addColumn('require_approval', 'boolean', col => col.notNull())
    .addColumn('last_seen_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('computer_pkey', ['id'])
    .execute();

  // Presence lands on this row every relay alarm; leave HOT headroom.
  await sql`ALTER TABLE computer SET (fillfactor = 85)`.execute(db);

  // One name per tenant, so the API can address a machine by the name a person typed.
  await db.schema.createIndex('computer_name_uq').on('computer').columns(['tenant_id', 'name']).unique().execute();

  // The relay looks a caller up by this digest alone, so two machines must never share one.
  // NULLs stay distinct, so every un-enrolled row is free of the constraint.
  await db.schema.createIndex('computer_credential_uq').on('computer').columns(['credential_hash']).unique().execute();

  await db.schema.createIndex('computer_tenant_idx').on('computer').columns(['tenant_id', 'created_at']).execute();

  await db.schema
    .createTable('computer_enrollment')
    .addColumn('code_hash', 'text', col => col.notNull())
    .addColumn('computer_id', 'text', col => col.notNull().references('computer.id').onDelete('cascade'))
    .addColumn('expires_at', 'timestamptz', col => col.notNull())
    .addColumn('used_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('computer_enrollment_pkey', ['code_hash'])
    .execute();

  await db.schema
    .createIndex('computer_enrollment_computer_idx')
    .on('computer_enrollment')
    .columns(['computer_id'])
    .execute();

  await db.schema
    .createTable('computer_agent_access')
    .addColumn('computer_id', 'text', col => col.notNull().references('computer.id').onDelete('cascade'))
    .addColumn('agent_name', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('computer_agent_access_pkey', ['computer_id', 'agent_name'])
    .execute();

  // Answers "may this agent be deleted" without scanning every computer.
  await db.schema
    .createIndex('computer_agent_access_agent_idx')
    .on('computer_agent_access')
    .columns(['agent_name'])
    .execute();

  await db.schema
    .createTable('computer_audit')
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('computer_id', 'text', col => col.notNull().references('computer.id').onDelete('cascade'))
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('session_id', 'text')
    .addColumn('turn_id', 'text')
    .addColumn('op', sql`varchar(16)`, col => col.notNull())
    .addColumn('command', 'text', col => col.notNull())
    .addColumn('exit_code', 'integer')
    .addColumn('duration_ms', 'integer', col => col.notNull())
    .addColumn('bytes_out', 'integer', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('computer_audit_pkey', ['id'])
    .execute();

  // Ids are ULIDs, so `id DESC` is both the newest-first order and the paging key.
  await sql`
    CREATE INDEX computer_audit_list_idx
      ON computer_audit (tenant_id, computer_id, id DESC)
  `.execute(db);

  // Drives the retention sweep.
  await db.schema.createIndex('computer_audit_created_idx').on('computer_audit').columns(['created_at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('computer_audit').ifExists().cascade().execute();
  await db.schema.dropTable('computer_agent_access').ifExists().cascade().execute();
  await db.schema.dropTable('computer_enrollment').ifExists().cascade().execute();
  await db.schema.dropTable('computer').ifExists().cascade().execute();
}
