import { applyD1Migrations, env as bindings, reset } from 'cloudflare:test';

import { WORKERS_EXECUTOR_ID } from '../../../src/workers/executorId';

const NOW = '2026-09-22T00:00:00.000Z';

describe('D1 upstream-merge migrations', () => {
  it('backfill rows that existed before them', async () => {
    await reset();
    const before = bindings.TEST_MIGRATIONS.filter(it => it.name < '0006_');
    await applyD1Migrations(bindings.DB, before);
    await bindings.DB.batch([
      bindings.DB.prepare(
        `INSERT INTO agent (id, tenant_id, name, manifest, created_by_subject, created_at, updated_at)
         VALUES ('a1', 't1', 'writer', jsonb('{"config":{"iteration_limit":5}}'), jsonb('{}'), ?1, ?1)`,
      ).bind(NOW),
      bindings.DB.prepare(
        `INSERT INTO session (tenant_id, session_id, created_by_subject, agent_id, last_activity_timestamp_ms, created_at, updated_at)
         VALUES ('t1', 's1', jsonb('{}'), 'a1', 0, ?1, ?1)`,
      ).bind(NOW),
      // Workers turn ids carry no `.executor` suffix; the SQLite backfill would copy the whole id.
      bindings.DB.prepare(
        `INSERT INTO turn (session_id, turn_id, first_turn_id, ancestor_ids, input, state, checkpoint, created_at, updated_at)
         VALUES ('s1', '01JTURN', '01JTURN', jsonb('[]'), jsonb('[]'), jsonb('{}'), jsonb('{}'), ?1, ?1)`,
      ).bind(NOW),
    ]);

    await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);

    const turn = await bindings.DB.prepare(`SELECT active_executor_id FROM turn WHERE turn_id = '01JTURN'`).first();
    expect(turn).toEqual({ active_executor_id: WORKERS_EXECUTOR_ID });
    const agent = await bindings.DB.prepare(`SELECT json(manifest) AS manifest FROM agent WHERE id = 'a1'`).first<{
      manifest: string;
    }>();
    expect(JSON.parse(agent?.manifest ?? '{}')).toEqual({
      config: { iteration_limit: 5, web_search: { enabled: false } },
    });
  });
});
