import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';
import { importAbsoluteModule } from '../../../../src/util/crossPlatform';

const BEFORE = '20260921_000002_computer';
const NOW = '2026-09-22T00:00:00.000Z';

function migrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      import: importAbsoluteModule,
      migrationFolder: path.join(import.meta.dirname, '../../../../src/db/sqlite/migrations'),
    }),
  });
}

async function seedIntegration(db: Kysely<Database>, input: { id: string; agent_name: string }): Promise<void> {
  const manifest = JSON.stringify({
    type: 'slack',
    bot_display_name: 'release-bot',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    default_agent_name: input.agent_name,
    allowed_channel_ids: [],
    allow_direct_messages: false,
    reply_mode: 'thread',
    approver_slack_user_ids: [],
    notification_rules: [],
  });
  await sql`
    INSERT INTO integration (id, tenant_id, type, external_account_id, manifest, created_by_subject, created_at, updated_at)
    VALUES (${input.id}, 't1', 'slack', ${`T0TEAM:${input.id}`}, jsonb(${manifest}), jsonb('{}'), ${NOW}, ${NOW})
  `.execute(db);
}

/** A database at the migration before this one, holding one integration bound to an existing agent. */
async function seededBeforeMigration(): Promise<Kysely<Database>> {
  const db = createSqliteDb(':memory:');
  const { error } = await migrator(db).migrateTo(BEFORE);
  expect(error).toBeUndefined();
  await sql`
    INSERT INTO agent (id, tenant_id, name, manifest, created_by_subject, created_at, updated_at)
    VALUES ('a1', 't1', 'writer', jsonb('{}'), jsonb('{}'), ${NOW}, ${NOW})
  `.execute(db);
  await seedIntegration(db, { id: 'i-good', agent_name: 'writer' });
  await sql`
    INSERT INTO integration_event (id, tenant_id, integration_id, event_id, received_at)
    VALUES ('e1', 't1', 'i-good', 'Ev1', ${NOW})
  `.execute(db);
  await sql`
    INSERT INTO integration_delivery (
      id, tenant_id, integration_id, conversation_key, turn_id, session_external_id, status, attempts,
      last_error, created_at, updated_at, next_attempt_at
    )
    VALUES ('d1', 't1', 'i-good', 'slack:T0TEAM:C1:1.0', 'turn-1', 'slack:T0TEAM:C1:1.0', 'sent', 1, NULL, ${NOW}, ${NOW}, ${NOW})
  `.execute(db);
  await sql`
    INSERT INTO integration_decision (
      id, tenant_id, integration_id, turn_id, session_id, decided_by_id, decided_by_display_name, decision, decided_at
    )
    VALUES ('x1', 't1', 'i-good', 'turn-1', 's1', 'U1', 'Ada', 'allow', ${NOW})
  `.execute(db);
  return db;
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info('integration')`.execute(db);
  return rows.map(row => row.name);
}

describe('20260923_000001_integration_agent (SQLite)', () => {
  it('binds each integration to its agent and drops the manifest key, keeping child rows', async () => {
    const db = await seededBeforeMigration();
    try {
      const { error } = await migrator(db).migrateToLatest();
      expect(error).toBeUndefined();

      const { rows } = await sql<{ agent_id: string; agent_name: string; manifest: unknown }>`
        SELECT agent_id, agent_name, json(manifest) AS manifest FROM integration WHERE id = 'i-good'
      `.execute(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent_id).toBe('a1');
      expect(rows[0]?.agent_name).toBe('writer');
      expect(rows[0]?.manifest).not.toHaveProperty('default_agent_name');
      expect(rows[0]?.manifest).toHaveProperty('bot_display_name', 'release-bot');

      const counts = await sql<{ events: number; deliveries: number; decisions: number }>`
        SELECT
          (SELECT COUNT(*) FROM integration_event) AS events,
          (SELECT COUNT(*) FROM integration_delivery) AS deliveries,
          (SELECT COUNT(*) FROM integration_decision) AS decisions
      `.execute(db);
      expect(counts.rows[0]).toEqual({ events: 1, deliveries: 1, decisions: 1 });

      // Deleting the agent now takes its integration and that integration's children with it.
      await sql`DELETE FROM agent WHERE id = 'a1'`.execute(db);
      const after = await sql<{ n: number }>`
        SELECT (SELECT COUNT(*) FROM integration) + (SELECT COUNT(*) FROM integration_delivery) AS n
      `.execute(db);
      expect(after.rows[0]?.n).toBe(0);
    } finally {
      await db.destroy();
    }
  });

  it('stops with the orphaned integration and agent named, and changes nothing', async () => {
    const db = await seededBeforeMigration();
    try {
      await seedIntegration(db, { id: 'i-orphan', agent_name: 'ghost' });

      const { error } = await migrator(db).migrateToLatest();

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('i-orphan');
      expect(message).toContain('"ghost"');
      expect(message).not.toContain('i-good');
      expect(message).toContain('recreate each missing agent');
      expect(await columnNames(db)).not.toContain('agent_id');
      const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM integration_delivery`.execute(db);
      expect(rows[0]?.n).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('restores the manifest key on the way down', async () => {
    const db = await seededBeforeMigration();
    try {
      expect((await migrator(db).migrateToLatest()).error).toBeUndefined();
      expect((await migrator(db).migrateTo(BEFORE)).error).toBeUndefined();

      expect(await columnNames(db)).not.toContain('agent_id');
      const { rows } = await sql<{ agent: string }>`
        SELECT json_extract(manifest, '$.default_agent_name') AS agent FROM integration WHERE id = 'i-good'
      `.execute(db);
      expect(rows[0]?.agent).toBe('writer');
    } finally {
      await db.destroy();
    }
  });
});
