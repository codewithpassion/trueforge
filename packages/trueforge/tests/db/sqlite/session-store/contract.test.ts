import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';

import { runStoreContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/storeContractSuite';
import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSessionStore (ISessionStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runStoreContractSuite((): ISessionStore => new SqliteSessionStore(env.db, new BetterSqliteAtomicRunner(env.db)));
});
