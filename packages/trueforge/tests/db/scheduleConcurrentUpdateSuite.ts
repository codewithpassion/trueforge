/**
 * `updated_at` guards of the SQLite-dialect schedule store, run against better-sqlite3 (Jest) and
 * D1 (vitest-pool-workers). A concurrent writer is simulated between the store's read and its batch.
 */
import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { sql, type Kysely } from 'kysely';

import { dispatchScheduledRuns } from '../../src/controller/scheduleDispatch';
import { ScheduleConcurrentUpdateError, type ScheduleWriteResult } from '../../src/db/scheduleStore';
import { SqliteAgentStore } from '../../src/db/sqlite/agent-store/SqliteAgentStore';
import type { AtomicRunner } from '../../src/db/sqlite/atomic';
import { SqliteScheduleStore } from '../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import type { Database } from '../../src/db/sqlite/types';
import type { WithTransaction } from '../../src/db/transaction';
import { nextTriggerAfter } from '../../src/runtime/cron';
import { ScheduleManifestSchema, type ScheduleManifest } from '../../src/schemas/schedule';
import { InterleavingAtomicRunner } from './interleavingAtomicRunner';
import { silentLogger } from './silentLogger';

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

export function runScheduleConcurrentUpdateSuite(deps: {
  getHarness: () => {
    db: Kysely<Database>;
    atomic: AtomicRunner<Database>;
    withTransaction: WithTransaction<Kysely<Database>>;
  };
  /** Pins `Date.now()`; the backend wrapper restores it after each test. */
  freezeNow: (ms: number) => void;
}): void {
  let harness: ReturnType<typeof deps.getHarness>;
  let runner: InterleavingAtomicRunner<Database>;
  let store: SqliteScheduleStore;

  beforeEach(() => {
    harness = deps.getHarness();
    runner = new InterleavingAtomicRunner(harness.atomic);
    store = new SqliteScheduleStore(harness.db, runner);
  });

  async function seedSchedule(runFrom: Date): Promise<ScheduleWriteResult> {
    const agent = await new SqliteAgentStore(harness.db).createAgent({
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

  it('two writers that pick the same updated_at: the loser neither deletes nor replaces the winner pending run', async () => {
    const runFrom = new Date('2026-08-27T10:00:00.000Z');
    const { schedule } = await seedSchedule(runFrom);
    // A clock behind the stored value makes both writers choose previous + 1 ms.
    deps.freezeNow(0);
    const winner = new SqliteScheduleStore(harness.db, harness.atomic);
    runner.beforeNextBatch(async () => {
      await winner.updateScheduleAndRun({
        tenant_id: TENANT,
        id: schedule.id,
        name: 'daily',
        manifest: manifest({ cron: '0 14 * * *' }),
        runFrom,
      });
    });

    await expect(
      store.updateScheduleAndRun({
        tenant_id: TENANT,
        id: schedule.id,
        name: 'daily',
        manifest: manifest({ cron: '0 15 * * *' }),
        runFrom,
      }),
    ).rejects.toBeInstanceOf(ScheduleConcurrentUpdateError);

    const current = await store.getSchedule({ tenant_id: TENANT, id: schedule.id });
    expect(current?.updated_at).toBe(new Date(Date.parse(schedule.updated_at) + 1).toISOString());
    expect(current?.manifest.cron).toBe('0 14 * * *');
    const pending = await store.getScheduledRunFor({ tenant_id: TENANT, schedule_id: schedule.id });
    expect(pending?.scheduled_for).toBe(
      nextTriggerAfter({ cron: '0 14 * * *', timezone: 'UTC', from: runFrom }).toISOString(),
    );
    for (const statement of runner.statements) {
      expect(statement.parameters.length).toBeLessThanOrEqual(100);
    }
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
      withTransaction: harness.withTransaction,
      onTriggered: () => {
        runner.beforeNextBatch(bumpScheduleUpdatedAt(schedule.id));
      },
      logger: silentLogger,
    });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(await store.getRun({ tenant_id: TENANT, id: due.id })).toEqual(
      expect.objectContaining({ status: 'triggered' }),
    );
    const next = await store.getScheduledRunFor({ tenant_id: TENANT, schedule_id: schedule.id });
    expect(next?.id).not.toBe(due.id);
    expect(Date.parse(next?.scheduled_for ?? '')).toBeGreaterThan(Date.now());
  });
}
