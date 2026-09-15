import { env as bindings } from 'cloudflare:test';

import { runSessionStoreAtomicWritesSuite } from '../../sessionStoreAtomicWritesSuite';
import { createD1TestDatabase, type D1TestDatabase } from '../testDatabase';

describe('SqliteSessionStore on D1: conditional-chain writes', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runSessionStoreAtomicWritesSuite(() => env);
});
