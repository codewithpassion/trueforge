import { sql, type Kysely } from 'kysely';
import { INTEGRATION_AGENT_ID_IDX } from '../../indexes';
import { integrationAgentOrphanError, type IntegrationAgentOrphan } from '../../integrationAgentOrphans';

/**
 * Binds each integration to one agent: `agent_id` (FK, cascade) and the `agent_name` snapshot are
 * backfilled from `manifest.default_agent_name`, which is then removed from the document. The
 * unique key gains `agent_id`, so one workspace may hold one bot per agent.
 * Runs inside the Migrator's transaction — do not nest `db.transaction()`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  // Checked before anything changes: SET NOT NULL would fail without naming the row.
  const { rows: orphans } = await sql<IntegrationAgentOrphan>`
    SELECT
      i.id,
      i.tenant_id,
      i.manifest->>'default_agent_name' AS agent_name
    FROM integration AS i
    LEFT JOIN agent AS a
      ON a.tenant_id = i.tenant_id
     AND a.name = i.manifest->>'default_agent_name'
    WHERE a.id IS NULL
    ORDER BY i.id
  `.execute(db);
  if (orphans.length > 0) {
    throw integrationAgentOrphanError(orphans);
  }

  await sql`
    ALTER TABLE integration
      ADD COLUMN agent_id text,
      ADD COLUMN agent_name text;
    UPDATE integration AS i
    SET agent_id = a.id,
        agent_name = a.name,
        manifest = i.manifest - 'default_agent_name'
    FROM agent AS a
    WHERE a.tenant_id = i.tenant_id
      AND a.name = i.manifest->>'default_agent_name';
    ALTER TABLE integration
      ALTER COLUMN agent_id SET NOT NULL,
      ALTER COLUMN agent_name SET NOT NULL;
    ALTER TABLE integration
      ADD CONSTRAINT integration_agent_id_fk
      FOREIGN KEY (agent_id) REFERENCES agent (id) ON DELETE CASCADE;
    DROP INDEX integration_account_uq;
    CREATE UNIQUE INDEX integration_account_uq
      ON integration (tenant_id, type, external_account_id, agent_id);
    CREATE INDEX ${sql.raw(INTEGRATION_AGENT_ID_IDX)}
      ON integration (tenant_id, agent_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    SET LOCAL lock_timeout = '5s';

    DROP INDEX IF EXISTS ${sql.raw(INTEGRATION_AGENT_ID_IDX)};
    DROP INDEX IF EXISTS integration_account_uq;
    CREATE UNIQUE INDEX integration_account_uq
      ON integration (tenant_id, type, external_account_id);
    UPDATE integration
    SET manifest = manifest || jsonb_build_object('default_agent_name', agent_name);
    ALTER TABLE integration
      DROP CONSTRAINT IF EXISTS integration_agent_id_fk;
    ALTER TABLE integration
      DROP COLUMN agent_name,
      DROP COLUMN agent_id;
  `.execute(db);
}
