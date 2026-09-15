import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import { env as bindings } from 'cloudflare:test';

import { runStoreContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/storeContractSuite';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteSessionStore on D1 (ISessionStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runStoreContractSuite((): ISessionStore => new SqliteSessionStore(env.db, env.atomic));
});
