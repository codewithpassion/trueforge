import { sql, type Kysely } from 'kysely';
import { INTEGRATION_AGENT_ID_IDX } from '../../indexes';
import { integrationAgentOrphanError, type IntegrationAgentOrphan } from '../../integrationAgentOrphans';

/**
 * Binds each integration to one agent — mirrors
 * db/postgres/migrations/20260923_000001_integration_agent.ts and
 * migrations/d1/0008_integration_agent.sql.
 *
 * `agent_id` / `agent_name` come from `manifest.default_agent_name`, which is then removed from
 * the document. The unique key gains `agent_id`, so one workspace may hold one bot per agent.
 *
 * SQLite STRICT cannot ADD a NOT NULL column without a DEFAULT, so `integration` is rebuilt with
 * foreign keys off, which keeps its events, deliveries and decisions from cascading on the drop.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Checked before anything changes: the rebuild would fail on NOT NULL without naming the row.
  const { rows: orphans } = await sql<IntegrationAgentOrphan>`
    SELECT
      i.id,
      i.tenant_id,
      json_extract(i.manifest, '$.default_agent_name') AS agent_name
    FROM integration AS i
    LEFT JOIN agent AS a
      ON a.tenant_id = i.tenant_id
     AND a.name = json_extract(i.manifest, '$.default_agent_name')
    WHERE a.id IS NULL
    ORDER BY i.id
  `.execute(db);
  if (orphans.length > 0) {
    throw integrationAgentOrphanError(orphans);
  }

  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`
        CREATE TABLE integration_new (
          id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (length(type) <= 32),
          external_account_id TEXT NOT NULL,
          manifest BLOB NOT NULL,
          created_by_subject BLOB NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (id),
          FOREIGN KEY (agent_id) REFERENCES agent (id) ON DELETE CASCADE
        ) STRICT
      `.execute(trx);

      // LEFT JOIN, so an agent deleted since the check fails on NOT NULL instead of dropping the row.
      await sql`
        INSERT INTO integration_new (
          id,
          tenant_id,
          agent_id,
          agent_name,
          type,
          external_account_id,
          manifest,
          created_by_subject,
          created_at,
          updated_at
        )
        SELECT
          i.id,
          i.tenant_id,
          a.id,
          a.name,
          i.type,
          i.external_account_id,
          jsonb_remove(i.manifest, '$.default_agent_name'),
          i.created_by_subject,
          i.created_at,
          i.updated_at
        FROM integration AS i
        LEFT JOIN agent AS a
          ON a.tenant_id = i.tenant_id
         AND a.name = json_extract(i.manifest, '$.default_agent_name')
      `.execute(trx);

      await sql`DROP TABLE integration`.execute(trx);
      await sql`ALTER TABLE integration_new RENAME TO integration`.execute(trx);

      // One bot per agent in a workspace: the agent is part of what makes a connection unique.
      await sql`
        CREATE UNIQUE INDEX integration_account_uq
          ON integration (tenant_id, type, external_account_id, agent_id)
      `.execute(trx);
      await sql`
        CREATE INDEX integration_list_idx
          ON integration (tenant_id, created_at, id)
      `.execute(trx);
      await sql`
        CREATE INDEX ${sql.raw(INTEGRATION_AGENT_ID_IDX)}
          ON integration (tenant_id, agent_id)
      `.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`
        CREATE TABLE integration_old (
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

      await sql`
        INSERT INTO integration_old (
          id, tenant_id, type, external_account_id, manifest, created_by_subject, created_at, updated_at
        )
        SELECT
          id,
          tenant_id,
          type,
          external_account_id,
          jsonb_set(manifest, '$.default_agent_name', agent_name),
          created_by_subject,
          created_at,
          updated_at
        FROM integration
      `.execute(trx);

      await sql`DROP TABLE integration`.execute(trx);
      await sql`ALTER TABLE integration_old RENAME TO integration`.execute(trx);

      await sql`
        CREATE UNIQUE INDEX integration_account_uq
          ON integration (tenant_id, type, external_account_id)
      `.execute(trx);
      await sql`
        CREATE INDEX integration_list_idx
          ON integration (tenant_id, created_at, id)
      `.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}
