import { env as bindings } from 'cloudflare:test';
import { SqliteAgentStore } from '../../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteScheduleStore } from '../../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { runScheduleStoreContractSuite } from '../../scheduleStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteScheduleStore on D1 (pending-run sync contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runScheduleStoreContractSuite({
    getAgentStore: () => new SqliteAgentStore(env.db),
    getScheduleStore: () => new SqliteScheduleStore(env.db, env.atomic),
  });
});
