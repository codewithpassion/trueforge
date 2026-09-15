import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { sql, type Kysely } from 'kysely';
import { createLogger } from 'winston';

import { dispatchScheduledRuns } from '../../../../src/controller/scheduleDispatch';
import { ScheduleConcurrentUpdateError, type ScheduleWriteResult } from '../../../../src/db/scheduleStore';
import { SqliteAgentStore } from '../../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { SqliteScheduleStore } from '../../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import type { Database } from '../../../../src/db/sqlite/types';
import { ScheduleManifestSchema, type ScheduleManifest } from '../../../../src/schemas/schedule';
import { InterleavingAtomicRunner } from '../interleavingAtomicRunner';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const TENANT = 'default';
const USER_SUBJECT: CreatedBySubject = { subject_id: 'tester', subject_type: 'user', subject_display_name: 'tester' };

function manifest(overrides: Partial<ScheduleManifest> = {}): ScheduleManifest {
  return ScheduleManifestSchema.parse({
    task: 'Say hello',
    cron: '0 13 * * *',
    timezone: 'UTC',
    status: 'active',
    ...overrides,
  });
}

function bumpScheduleUpdatedAt(scheduleId: string) {
  return async (executor: Kysely<Database>): Promise<void> => {
    await sql`UPDATE schedule SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ${scheduleId}`.execute(executor);
  };
}

describe('SqliteScheduleStore updated_at guard', () => {
  let env: SqliteTestDatabase;
  let runner: InterleavingAtomicRunner<Database>;
  let store: SqliteScheduleStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    runner = new InterleavingAtomicRunner(new BetterSqliteAtomicRunner(env.db));
    store = new SqliteScheduleStore(env.db, runner);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  async function seedSchedule(runFrom: Date): Promise<ScheduleWriteResult> {
    const agent = await new SqliteAgentStore(env.db).createAgent({
      tenant_id: TENANT,
      created_by_subject: USER_SUBJECT,
      name: 'reporter',
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'anthropic/claude-sonnet-4-6' }, instructions: 'Be helpful.' }),
      external_id: null,
    });
    return store.createScheduleAndRun({
      tenant_id: TENANT,
      agent_id: agent.id,
      agent_name: agent.name,
      name: 'daily',
      manifest: manifest(),
      created_by_subject: USER_SUBJECT,
      runFrom,
    });
  }

  it('updateScheduleAndRun throws ScheduleConcurrentUpdateError and writes nothing when the schedule changed after its read', async () => {
    const { schedule, pendingRun } = await seedSchedule(new Date('2026-08-27T10:00:00.000Z'));
    runner.beforeNextBatch(bumpScheduleUpdatedAt(schedule.id));

    await expect(
      store.updateScheduleAndRun({
        tenant_id: TENANT,
        id: schedule.id,
        name: 'renamed',
        manifest: manifest({ cron: '0 14 * * *' }),
        runFrom: new Date('2026-08-27T10:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ScheduleConcurrentUpdateError);

    const current = await store.getSchedule({ tenant_id: TENANT, id: schedule.id });
    expect(current?.name).toBe('daily');
    expect(current?.manifest.cron).toBe('0 13 * * *');
    expect(await store.getScheduledRunFor({ tenant_id: TENANT, schedule_id: schedule.id })).toEqual(pendingRun);
  });

  it('finishRun throws ScheduleConcurrentUpdateError on a stale schedule and leaves the run pending', async () => {
    const { schedule, pendingRun } = await seedSchedule(new Date('2026-08-27T10:00:00.000Z'));
    if (pendingRun === undefined) {
      throw new Error('Expected an active schedule to have a pending run');
    }
    runner.beforeNextBatch(bumpScheduleUpdatedAt(schedule.id));

    await expect(
      store.finishRun({
        run: pendingRun,
        status: 'triggered',
        reason: null,
        schedule,
        next_scheduled_for: new Date('2026-08-29T13:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ScheduleConcurrentUpdateError);

    expect(await store.getRun({ tenant_id: TENANT, id: pendingRun.id })).toEqual(pendingRun);
  });

  it('dispatch retries a finish that raced a schedule write', async () => {
    const { schedule, pendingRun } = await seedSchedule(new Date(Date.now() + 365 * 24 * 3600 * 1000));
    if (pendingRun === undefined) {
      throw new Error('Expected an active schedule to have a pending run');
    }
    await store.updateRunStatus({ tenant_id: TENANT, id: pendingRun.id, status: 'failed' });
    const due = await store.createRun({
      tenant_id: TENANT,
      schedule_id: schedule.id,
      name: 'due-run',
      scheduled_for: new Date(Date.now() - 60_000),
      status: 'scheduled',
      created_by_subject: USER_SUBJECT,
    });

    const result = await dispatchScheduledRuns({
      store,
      withTransaction: callback => env.db.transaction().execute(callback),
      onTriggered: () => {
        runner.beforeNextBatch(bumpScheduleUpdatedAt(schedule.id));
      },
      logger: createLogger({ silent: true }),
    });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(await store.getRun({ tenant_id: TENANT, id: due.id })).toEqual(
      expect.objectContaining({ status: 'triggered' }),
    );
    const next = await store.getScheduledRunFor({ tenant_id: TENANT, schedule_id: schedule.id });
    expect(next?.id).not.toBe(due.id);
    expect(Date.parse(next?.scheduled_for ?? '')).toBeGreaterThan(Date.now());
  });
});
