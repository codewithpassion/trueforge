import { applyD1Migrations, env as bindings, reset } from 'cloudflare:test';

const NOW = '2026-09-22T00:00:00.000Z';

function insertIntegration(input: { id: string; agent_name: string }) {
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
  return bindings.DB.prepare(
    `INSERT INTO integration (id, tenant_id, type, external_account_id, manifest, created_by_subject, created_at, updated_at)
     VALUES (?1, 't1', 'slack', ?2, jsonb(?3), jsonb('{}'), ?4, ?4)`,
  ).bind(input.id, `T0TEAM:${input.id}`, manifest, NOW);
}

/** Applies everything before 0008 and seeds one integration, bound to an existing agent, with children. */
async function seededBefore0008(): Promise<void> {
  await reset();
  await applyD1Migrations(
    bindings.DB,
    bindings.TEST_MIGRATIONS.filter(it => it.name < '0008_'),
  );
  await bindings.DB.batch([
    bindings.DB.prepare(
      `INSERT INTO agent (id, tenant_id, name, manifest, created_by_subject, created_at, updated_at)
       VALUES ('a1', 't1', 'writer', jsonb('{}'), jsonb('{}'), ?1, ?1)`,
    ).bind(NOW),
    insertIntegration({ id: 'i-good', agent_name: 'writer' }),
    bindings.DB.prepare(
      `INSERT INTO integration_event (id, tenant_id, integration_id, event_id, received_at)
       VALUES ('e1', 't1', 'i-good', 'Ev1', ?1)`,
    ).bind(NOW),
    bindings.DB.prepare(
      `INSERT INTO integration_delivery (
         id, tenant_id, integration_id, conversation_key, turn_id, session_external_id, status, attempts,
         last_error, created_at, updated_at, next_attempt_at
       )
       VALUES ('d1', 't1', 'i-good', 'slack:T0TEAM:C1:1.0', 'turn-1', 'slack:T0TEAM:C1:1.0', 'sent', 1, NULL, ?1, ?1, ?1)`,
    ).bind(NOW),
    bindings.DB.prepare(
      `INSERT INTO integration_decision (
         id, tenant_id, integration_id, turn_id, session_id, decided_by_id, decided_by_display_name, decision, decided_at
       )
       VALUES ('x1', 't1', 'i-good', 'turn-1', 's1', 'U1', 'Ada', 'allow', ?1)`,
    ).bind(NOW),
  ]);
}

async function childCounts() {
  return bindings.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM integration_event) AS events,
       (SELECT COUNT(*) FROM integration_delivery) AS deliveries,
       (SELECT COUNT(*) FROM integration_decision) AS decisions`,
  ).first();
}

describe('D1 0008_integration_agent', () => {
  it('binds each integration to its agent, drops the manifest key, and keeps child rows', async () => {
    await seededBefore0008();

    await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);

    const row = await bindings.DB.prepare(
      `SELECT agent_id, agent_name, json(manifest) AS manifest FROM integration WHERE id = 'i-good'`,
    ).first<{ agent_id: string; agent_name: string; manifest: string }>();
    expect(row?.agent_id).toBe('a1');
    expect(row?.agent_name).toBe('writer');
    const manifest: unknown = JSON.parse(row?.manifest ?? '{}');
    expect(manifest).not.toHaveProperty('default_agent_name');
    expect(manifest).toHaveProperty('bot_display_name', 'release-bot');
    expect(await childCounts()).toEqual({ events: 1, deliveries: 1, decisions: 1 });
    const leftovers = await bindings.DB.prepare(
      `SELECT name FROM sqlite_master WHERE name LIKE '%\\_keep' ESCAPE '\\' OR name = 'integration_new'`,
    ).all();
    expect(leftovers.results).toEqual([]);

    // The agent binding cascades: deleting the agent removes its integration and the children.
    await bindings.DB.prepare(`DELETE FROM agent WHERE id = 'a1'`).run();
    expect(await childCounts()).toEqual({ events: 0, deliveries: 0, decisions: 0 });
  });

  it('clears a copy a failed, un-rolled-back run left behind', async () => {
    await seededBefore0008();
    const migration = bindings.TEST_MIGRATIONS.find(it => it.name.startsWith('0008_'));
    const createCopy = migration?.queries.find(query => query.includes('CREATE TABLE IF NOT EXISTS integration_new'));
    if (createCopy === undefined) {
      throw new Error('0008 no longer creates integration_new');
    }
    await bindings.DB.batch([
      bindings.DB.prepare(createCopy),
      bindings.DB.prepare(
        `INSERT INTO integration_new (id, tenant_id, agent_id, agent_name, type, external_account_id, manifest,
           created_by_subject, created_at, updated_at)
         VALUES ('stale', 't1', 'a1', 'writer', 'slack', 'T0STALE', jsonb('{}'), jsonb('{}'), ?1, ?1)`,
      ).bind(NOW),
    ]);

    await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);

    const ids = await bindings.DB.prepare(`SELECT id FROM integration ORDER BY id`).all();
    expect(ids.results).toEqual([{ id: 'i-good' }]);
  });

  it('fails on an integration whose agent is missing', async () => {
    await seededBefore0008();
    await insertIntegration({ id: 'i-orphan', agent_name: 'ghost' }).run();

    await expect(applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS)).rejects.toThrow(/NOT NULL/);

    expect(await childCounts()).toEqual({ events: 1, deliveries: 1, decisions: 1 });
    const probe = await bindings.DB.prepare(`SELECT name FROM sqlite_master WHERE name = 'integration_new'`).all();
    expect(probe.results).toEqual([]);
  });
});
