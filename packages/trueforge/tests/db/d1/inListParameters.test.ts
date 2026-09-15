import { env as bindings } from 'cloudflare:test';
import { runInListParametersSuite } from '../inListParametersSuite';
import { createD1TestDatabase, type D1TestDatabase } from './testDatabase';

describe('D1 store id-list filters (bound parameter count)', () => {
  let env: D1TestDatabase;

  beforeEach(async () => {
    env = await createD1TestDatabase(bindings);
  });

  runInListParametersSuite(() => env);
});
