import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { env as bindings } from 'cloudflare:test';

import { AgentNameConflictError } from '../../../../src/db/agentStore';
import {
  ScheduleNameConflictError,
  ScheduleRunConflictError,
  type ScheduleWriteResult,
} from '../../../../src/db/scheduleStore';
import { SqliteAgentStore } from '../../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteScheduleStore } from '../../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { ScheduleManifestSchema, type ScheduleManifest } from '../../../../src/schemas/schedule';
import { createD1TestDatabase } from '../testDatabase';

const TENANT = 'default';
const USER_SUBJECT: CreatedBySubject = { subject_id: 'tester', subject_type: 'user', subject_display_name: 'tester' };
const RUN_FROM = new Date('2026-08-27T10:00:00.000Z');

function manifest(overrides: Partial<ScheduleManifest> = {}): ScheduleManifest {
  return ScheduleManifestSchema.parse({
    task: 'Say hello',
    cron: '0 13 * * *',
    timezone: 'UTC',
    status: 'active',
    ...overrides,
  });
}

describe('SqliteScheduleStore and SqliteAgentStore on D1: unique violations', () => {
  let store: SqliteScheduleStore;
  let agentStore: SqliteAgentStore;

  beforeEach(async () => {
    const env = await createD1TestDatabase(bindings);
    store = new SqliteScheduleStore(env.db, env.atomic);
    agentStore = new SqliteAgentStore(env.db);
  });

  function createAgent(name: string) {
    return agentStore.createAgent({
      tenant_id: TENANT,
      created_by_subject: USER_SUBJECT,
      name,
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'anthropic/claude-sonnet-4-6' }, instructions: 'Be helpful.' }),
      external_id: null,
    });
  }

  async function seedSchedule(name: string): Promise<ScheduleWriteResult> {
    const agent =
      (await agentStore.getAgent({ tenant_id: TENANT, name: 'reporter' })) ?? (await createAgent('reporter'));
    return store.createScheduleAndRun({
      tenant_id: TENANT,
      agent_id: agent.id,
      agent_name: agent.name,
      name,
      manifest: manifest(),
      created_by_subject: USER_SUBJECT,
      runFrom: RUN_FROM,
    });
  }

  it('maps a duplicate agent name to AgentNameConflictError', async () => {
    await createAgent('dup');
    await expect(createAgent('dup')).rejects.toBeInstanceOf(AgentNameConflictError);
  });

  it('maps a schedule name clash inside a batch to ScheduleNameConflictError', async () => {
    await seedSchedule('daily');
    await expect(seedSchedule('daily')).rejects.toBeInstanceOf(ScheduleNameConflictError);
  });

  it('maps a schedule_run unique violation inside a batch to ScheduleRunConflictError, not a name clash', async () => {
    const { schedule } = await seedSchedule('daily');
    const finished = await store.createRun({
      tenant_id: TENANT,
      schedule_id: schedule.id,
      name: 'manual-run',
      scheduled_for: RUN_FROM,
      status: 'triggered',
      created_by_subject: USER_SUBJECT,
    });

    // The schedule still has its pending run, so the next pending insert violates schedule_run_pending_uq.
    await expect(
      store.finishRun({
        run: finished,
        status: 'triggered',
        reason: null,
        schedule,
        next_scheduled_for: new Date('2026-08-29T13:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ScheduleRunConflictError);
  });
});
