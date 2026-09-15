import { env as bindings } from 'cloudflare:test';
import { SqliteSessionMetricsStore } from '../../../../src/db/sqlite/session-metrics/SqliteSessionMetricsStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { runSessionMetricsStoreContractSuite } from '../../session-metrics/metricsContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteSessionMetricsStore on D1 (metrics contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runSessionMetricsStoreContractSuite(() => ({
    sessionStore: new SqliteSessionStore(env.db, env.atomic),
    metricsStore: new SqliteSessionMetricsStore(env.db),
  }));
});
