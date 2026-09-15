import { env as bindings } from 'cloudflare:test';

import { createD1Persistence } from '../../../../src/db/d1/persistence';
import { runScheduleDispatchContractSuite } from '../../scheduleDispatchContractSuite';
import { createD1TestDatabase } from '../testDatabase';

describe('dispatchScheduledRuns (D1 contract)', () => {
  let persistence: ReturnType<typeof createD1Persistence>;

  beforeEach(async () => {
    await createD1TestDatabase(bindings);
    persistence = createD1Persistence({ database: bindings.DB, mcpClientName: 'trueforge-test' });
  });

  runScheduleDispatchContractSuite({
    getAgentStore: () => persistence.agentStore,
    getScheduleStore: () => persistence.scheduleStore,
    withTransaction: callback => persistence.withTransaction(callback),
  });
});
