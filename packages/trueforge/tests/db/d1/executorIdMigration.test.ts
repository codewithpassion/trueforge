import { env as bindings } from 'cloudflare:test';

import { WORKERS_EXECUTOR_ID } from '../../../src/workers/executorId';

describe('D1 active_executor_id migration', () => {
  it('backfills existing turns with the executor SessionDO records', () => {
    const migration = bindings.TEST_MIGRATIONS.find(it => it.name.startsWith('0007_'));
    const backfill = migration?.queries.find(query => query.startsWith('UPDATE turn'));
    expect(backfill).toContain(`'${WORKERS_EXECUTOR_ID}'`);
  });
});
