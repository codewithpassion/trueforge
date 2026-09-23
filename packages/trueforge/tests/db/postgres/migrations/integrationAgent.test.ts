import { sql, type Kysely } from 'kysely';

import { migrateToLatest } from '../../../../src/db/migratePostgres';
import type { Database } from '../../../../src/db/postgres/types';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

const BEFORE = '20260921_000002_computer';

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
    VALUES (${input.id}, 't1', 'slack', ${`T0TEAM:${input.id}`}, ${manifest}::jsonb, '{}'::jsonb, now(), now())
  `.execute(db);
}

/** A database at the migration before this one, holding one integration bound to an existing agent. */
async function seededBeforeMigration(): Promise<PostgresTestDatabase> {
  const env = await createPostgresTestDatabase(BEFORE);
  if (env === undefined) {
    throw new Error('Postgres test environment unavailable despite globalSetup probe');
  }
  await sql`
    INSERT INTO agent (id, tenant_id, name, description, manifest, created_by_subject, created_at, updated_at)
    VALUES ('a1', 't1', 'writer', '', '{}'::jsonb, '{}'::jsonb, now(), now())
  `.execute(env.db);
  await seedIntegration(env.db, { id: 'i-good', agent_name: 'writer' });
  await sql`
    INSERT INTO integration_event (id, tenant_id, integration_id, event_id, received_at)
    VALUES ('e1', 't1', 'i-good', 'Ev1', now())
  `.execute(env.db);
  return env;
}

describePg('20260923_000001_integration_agent (Postgres)', () => {
  it('binds each integration to its agent and drops the manifest key', async () => {
    const env = await seededBeforeMigration();
    try {
      await migrateToLatest(env.db);

      const { rows } = await sql<{ agent_id: string; agent_name: string; manifest: unknown }>`
        SELECT agent_id, agent_name, manifest FROM integration WHERE id = 'i-good'
      `.execute(env.db);
      expect(rows[0]?.agent_id).toBe('a1');
      expect(rows[0]?.agent_name).toBe('writer');
      expect(rows[0]?.manifest).not.toHaveProperty('default_agent_name');
      const events = await sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM integration_event`.execute(env.db);
      expect(events.rows[0]?.n).toBe(1);

      await sql`DELETE FROM agent WHERE id = 'a1'`.execute(env.db);
      const left = await sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM integration`.execute(env.db);
      expect(left.rows[0]?.n).toBe(0);
    } finally {
      await env.teardown();
    }
  });

  it('stops with the orphaned integration and agent named, and changes nothing', async () => {
    const env = await seededBeforeMigration();
    try {
      await seedIntegration(env.db, { id: 'i-orphan', agent_name: 'ghost' });

      const failure = await migrateToLatest(env.db).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : '';
      expect(message).toContain('i-orphan');
      expect(message).toContain('"ghost"');
      expect(message).not.toContain('i-good');
      const { rows } = await sql<{ n: number }>`
        SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'integration' AND column_name = 'agent_id'
      `.execute(env.db);
      expect(rows[0]?.n).toBe(0);
    } finally {
      await env.teardown();
    }
  });
});
