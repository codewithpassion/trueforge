import { env as bindings } from 'cloudflare:test';

import { runSessionFileMetadataContractSuite } from '../../../../../trueforge-core/tests/agent-session/store/sessionFileMetadataContractSuite';
import { SqliteSessionFileMetadataStore } from '../../../../src/db/sqlite/session-file-store/SqliteSessionFileMetadataStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteSessionFileMetadataStore on D1 (session_file contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runSessionFileMetadataContractSuite(() => ({
    metadata: new SqliteSessionFileMetadataStore(env.db),
    sessionStore: new SqliteSessionStore(env.db, env.atomic),
  }));
});
