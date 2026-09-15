import { env as bindings } from 'cloudflare:test';
import { vi } from 'vitest';

import { runScheduleConcurrentUpdateSuite } from '../../scheduleConcurrentUpdateSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteScheduleStore on D1: updated_at guard', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  runScheduleConcurrentUpdateSuite({
    getHarness: () => env,
    freezeNow: ms => {
      vi.spyOn(Date, 'now').mockReturnValue(ms);
    },
  });
});
