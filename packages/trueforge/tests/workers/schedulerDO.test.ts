import { AgentSpecSchema, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { createScheduledController, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { dispatchScheduledRuns, SCHEDULE_DISPATCH_INTERVAL_MS } from '../../src/controller/scheduleDispatch';
import { ScheduleManifestSchema } from '../../src/schemas/schedule';
import worker from '../../src/workers/index';
import { SCHEDULER_INSTANCE_NAME } from '../../src/workers/SchedulerDO';
import { d1Persistence, migrateDatabase, TENANT_ID, upsertMockProvider, USER_REF } from './harness';

vi.mock('../../src/controller/scheduleDispatch', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/controller/scheduleDispatch')>();
  return { ...actual, dispatchScheduledRuns: vi.fn(actual.dispatchScheduledRuns) };
});

const HOUR_MS = 3_600_000;
const CREATOR = { subject_id: USER_REF, subject_type: 'user', subject_display_name: USER_REF };
const ENSURE_IDLE = 'ensure-alarm-idle';
const ENSURE_ARMED = 'ensure-alarm-armed';

function schedulerStub(name: string) {
  return env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName(name));
}

function alarmOf(name: string): Promise<number | null> {
  return runInDurableObject(schedulerStub(name), (_instance, state) => state.storage.getAlarm());
}

/** One pass of the singleton, run now; the hour-away alarm it replaces never fires on its own. */
async function runDispatchPass(): Promise<void> {
  const stub = schedulerStub(SCHEDULER_INSTANCE_NAME);
  await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + HOUR_MS));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

/** An active hourly schedule whose pending run was due an hour ago. */
async function createDueSchedule(name: string) {
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: 'text' });
  const agent = await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    created_by_subject: CREATOR,
    name,
    description: 'Scheduler test agent.',
    manifest: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
    external_id: null,
  });
  const { schedule } = await stores.scheduleStore.createScheduleAndRun({
    tenant_id: TENANT_ID,
    agent_id: agent.id,
    agent_name: agent.name,
    name,
    manifest: ScheduleManifestSchema.parse({ task: 'Say hi', cron: '0 * * * *', timezone: 'UTC' }),
    created_by_subject: CREATOR,
    runFrom: new Date(Date.now() - 2 * HOUR_MS),
  });
  const pending = await stores.scheduleStore.getScheduledRunFor({ tenant_id: TENANT_ID, schedule_id: schedule.id });
  if (pending === undefined) {
    throw new Error(`Schedule ${name} has no pending run`);
  }
  return { stores, schedule, pending };
}

async function turnsOfRun({ stores, runId }: { stores: ReturnType<typeof d1Persistence>; runId: string }) {
  const session = await new Sessions({ sessionStore: stores.sessionStore }).getByExternalId({
    tenant_id: TENANT_ID,
    external_id: runId,
  });
  if (session === undefined) {
    return undefined;
  }
  return (await session.listTurns({ limit: 10 })).data;
}

beforeAll(async () => {
  await migrateDatabase();
});

afterEach(async () => {
  // A leftover alarm would start a second, concurrent dispatcher during later tests.
  await Promise.all(
    [SCHEDULER_INSTANCE_NAME, ENSURE_IDLE, ENSURE_ARMED].map(name =>
      runInDurableObject(schedulerStub(name), (_instance, state) => state.storage.deleteAlarm()),
    ),
  );
  const actual = await vi.importActual<typeof import('../../src/controller/scheduleDispatch')>(
    '../../src/controller/scheduleDispatch',
  );
  vi.mocked(dispatchScheduledRuns).mockImplementation(actual.dispatchScheduledRuns);
});

/** Alarm-state tests arm real alarms; a stubbed pass keeps them from dispatching against the shared database. */
function stubDispatchPasses(): void {
  vi.mocked(dispatchScheduledRuns).mockResolvedValue({ dispatched: 0, failed: 0 });
}

describe('SchedulerDO', () => {
  it('starts a due run in the session keyed by the run id and adds the next pending run', async () => {
    const { stores, schedule, pending } = await createDueSchedule('scheduler-due');

    await runDispatchPass();

    expect((await stores.scheduleStore.getRun({ tenant_id: TENANT_ID, id: pending.id }))?.status).toBe('triggered');
    expect(await turnsOfRun({ stores, runId: pending.id })).toHaveLength(1);
    const next = await stores.scheduleStore.getScheduledRunFor({ tenant_id: TENANT_ID, schedule_id: schedule.id });
    expect(next?.id).not.toBe(pending.id);
    expect(Date.parse(next?.scheduled_for ?? '')).toBeGreaterThan(Date.now());
  });

  it('does not start a second turn when the same run is dispatched again', async () => {
    const { stores, schedule, pending } = await createDueSchedule('scheduler-redispatch');
    await runDispatchPass();
    // As if the pass had stopped after the handoff and before recording it.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM schedule_run WHERE schedule_id = ? AND status = 'scheduled'").bind(schedule.id),
      env.DB.prepare("UPDATE schedule_run SET status = 'scheduled', triggered_at = NULL WHERE id = ?").bind(pending.id),
    ]);

    await runDispatchPass();

    expect((await stores.scheduleStore.getRun({ tenant_id: TENANT_ID, id: pending.id }))?.status).toBe('triggered');
    expect(await turnsOfRun({ stores, runId: pending.id })).toHaveLength(1);
  });

  it('runs a paused schedule’s existing pending row once and adds no new one', async () => {
    const { stores, schedule } = await createDueSchedule('scheduler-paused');
    // Pausing deletes the pending row, so recreate the row a pass that raced the pause would still see.
    await stores.scheduleStore.updateScheduleAndRun({
      tenant_id: TENANT_ID,
      id: schedule.id,
      name: schedule.name,
      manifest: { ...schedule.manifest, status: 'paused' },
      runFrom: new Date(),
    });
    const leftover = await stores.scheduleStore.createRun({
      tenant_id: TENANT_ID,
      schedule_id: schedule.id,
      name: 'scheduler-paused-leftover',
      scheduled_for: new Date(Date.now() - HOUR_MS),
      status: 'scheduled',
      created_by_subject: CREATOR,
    });

    await runDispatchPass();

    expect((await stores.scheduleStore.getRun({ tenant_id: TENANT_ID, id: leftover.id }))?.status).toBe('triggered');
    expect(await turnsOfRun({ stores, runId: leftover.id })).toHaveLength(1);
    expect(
      await stores.scheduleStore.getScheduledRunFor({ tenant_id: TENANT_ID, schedule_id: schedule.id }),
    ).toBeUndefined();
  });

  it('re-arms the alarm when a dispatch pass throws', async () => {
    const dispatch = vi.mocked(dispatchScheduledRuns);
    const callsBefore = dispatch.mock.calls.length;
    dispatch.mockRejectedValueOnce(new Error('D1 is unavailable'));
    const before = Date.now();

    await runDispatchPass();

    expect(dispatch.mock.calls.length).toBe(callsBefore + 1);
    const alarm = await alarmOf(SCHEDULER_INSTANCE_NAME);
    expect(alarm).toBeGreaterThanOrEqual(before + SCHEDULE_DISPATCH_INTERVAL_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + SCHEDULE_DISPATCH_INTERVAL_MS);
  });

  it('ensureAlarm leaves an armed alarm at its time', async () => {
    stubDispatchPasses();
    const armedAt = Date.now() + HOUR_MS;
    await runInDurableObject(schedulerStub(ENSURE_ARMED), (_instance, state) => state.storage.setAlarm(armedAt));

    await schedulerStub(ENSURE_ARMED).ensureAlarm();

    expect(await alarmOf(ENSURE_ARMED)).toBe(armedAt);
  });

  // The armed alarm is due at once and reads as null while its pass runs, so wait for the re-arm.
  it('ensureAlarm arms an idle scheduler', async () => {
    stubDispatchPasses();
    expect(await alarmOf(ENSURE_IDLE)).toBeNull();

    await schedulerStub(ENSURE_IDLE).ensureAlarm();

    await vi.waitFor(async () => {
      expect(await alarmOf(ENSURE_IDLE)).not.toBeNull();
    });
  });

  it('the cron handler arms the singleton scheduler', async () => {
    stubDispatchPasses();
    expect(await alarmOf(SCHEDULER_INSTANCE_NAME)).toBeNull();

    await worker.scheduled(createScheduledController({ cron: '*/5 * * * *', scheduledTime: Date.now() }), env);

    await vi.waitFor(async () => {
      expect(await alarmOf(SCHEDULER_INSTANCE_NAME)).not.toBeNull();
    });
  });
});
