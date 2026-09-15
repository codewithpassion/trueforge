import { env as bindings } from 'cloudflare:test';
import { SqliteSkillStore } from '../../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { runSkillStoreContractSuite } from '../../skillStoreContractSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteSkillStore on D1 (ISkillStore contract)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runSkillStoreContractSuite(() => new SqliteSkillStore(env.db));
});
