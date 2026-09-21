import { sql, type Kysely } from 'kysely';

/**
 * Remote computers for SQLite — mirrors
 * db/postgres/migrations/20260921_000002_computer.ts and
 * migrations/d1/0005_computer.sql.
 *
 * SQLite differences: `require_approval` is INTEGER 0/1, `capabilities` is a BLOB JSONB
 * document, timestamps are ISO TEXT, tables are STRICT. No parent table is rebuilt, so no
 * `PRAGMA foreign_keys` toggle is needed — the migration owns its own transaction because
 * Kysely's Migrator does not wrap SQLite migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE computer (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK (length(name) <= 128),
        owner_subject TEXT NOT NULL,
        status TEXT NOT NULL CHECK (length(status) <= 16),
        credential_hash TEXT,
        hostname TEXT,
        os TEXT,
        arch TEXT,
        agent_version TEXT,
        capabilities BLOB,
        run_as_user TEXT,
        require_approval INTEGER NOT NULL,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // One name per tenant, so the API can address a machine by the name a person typed.
    await sql`
      CREATE UNIQUE INDEX computer_name_uq
        ON computer (tenant_id, name)
    `.execute(trx);

    // The relay looks a caller up by this digest alone, so two machines must never share one.
    // NULLs stay distinct in SQLite, so every un-enrolled row is free of the constraint.
    await sql`
      CREATE UNIQUE INDEX computer_credential_uq
        ON computer (credential_hash)
    `.execute(trx);

    await sql`
      CREATE INDEX computer_tenant_idx
        ON computer (tenant_id, created_at)
    `.execute(trx);

    // Single-use codes: the hash is the key, and `used_at` is what burns one.
    await sql`
      CREATE TABLE computer_enrollment (
        code_hash TEXT NOT NULL,
        computer_id TEXT NOT NULL REFERENCES computer (id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (code_hash)
      ) STRICT
    `.execute(trx);

    await sql`
      CREATE INDEX computer_enrollment_computer_idx
        ON computer_enrollment (computer_id)
    `.execute(trx);

    await sql`
      CREATE TABLE computer_agent_access (
        computer_id TEXT NOT NULL REFERENCES computer (id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (computer_id, agent_name)
      ) STRICT
    `.execute(trx);

    // Answers "may this agent be deleted" without scanning every computer.
    await sql`
      CREATE INDEX computer_agent_access_agent_idx
        ON computer_agent_access (agent_name)
    `.execute(trx);

    await sql`
      CREATE TABLE computer_audit (
        id TEXT NOT NULL,
        computer_id TEXT NOT NULL REFERENCES computer (id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        op TEXT NOT NULL CHECK (length(op) <= 16),
        command TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms INTEGER NOT NULL,
        bytes_out INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // Ids are ULIDs, so `id DESC` is both the newest-first order and the paging key.
    await sql`
      CREATE INDEX computer_audit_list_idx
        ON computer_audit (tenant_id, computer_id, id DESC)
    `.execute(trx);

    // Drives the retention sweep.
    await sql`
      CREATE INDEX computer_audit_created_idx
        ON computer_audit (created_at)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS computer_audit`.execute(trx);
    await sql`DROP TABLE IF EXISTS computer_agent_access`.execute(trx);
    await sql`DROP TABLE IF EXISTS computer_enrollment`.execute(trx);
    await sql`DROP TABLE IF EXISTS computer`.execute(trx);
  });
}
