import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DELIVERY_RETRY_INTERVAL_MS } from '../../src/integrations/retryDeliveries';
import { migrateDatabase } from './harness';

interface SweepCall {
  /** Wall time either side of the pass, so a stamp written before it is distinguishable. */
  startedAt: number;
  finishedAt: number;
  signalPresent: boolean;
  signalAborted: boolean;
}

const sweeps = vi.hoisted((): SweepCall[] => []);

// The real sweep talks to D1 and would post to a channel; only its contract with the alarm
// matters here — that it is handed the pass's deadline, and paced by a stamp written after it.
vi.mock('../../src/integrations/retryDeliveries', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/integrations/retryDeliveries')>();
  return {
    ...actual,
    retryIntegrationDeliveries: async (deps: { signal?: AbortSignal }) => {
      const startedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, 25));
      sweeps.push({
        startedAt,
        finishedAt: Date.now(),
        signalPresent: deps.signal !== undefined,
        signalAborted: deps.signal?.aborted === true,
      });
    },
  };
});

const INSTANCE = 'sweep-budget';
const LAST_DELIVERY_RETRY_KEY = 'last_delivery_retry_at';

function stub() {
  return env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName(INSTANCE));
}

/** One alarm pass, run now; the far-future alarm it replaces never fires on its own. */
async function runPass(): Promise<void> {
  await runInDurableObject(stub(), (_instance, state) => state.storage.setAlarm(Date.now() + 3_600_000));
  expect(await runDurableObjectAlarm(stub())).toBe(true);
}

function lastSweepAt(): Promise<number | undefined> {
  return runInDurableObject(stub(), (_instance, state) => state.storage.get<number>(LAST_DELIVERY_RETRY_KEY));
}

beforeAll(async () => {
  await migrateDatabase();
});

beforeEach(async () => {
  sweeps.length = 0;
  // Durable Object storage outlives a test, so each case starts with the sweep due.
  await runInDurableObject(stub(), (_instance, state) => state.storage.delete(LAST_DELIVERY_RETRY_KEY));
});

describe('SchedulerDO delivery sweep', () => {
  it('hands the pass deadline to the sweep and paces it by a stamp written afterwards', async () => {
    await runPass();

    expect(sweeps).toHaveLength(1);
    // The alarm's own budget is what stops a sweep that would outlive the pass.
    expect(sweeps[0]?.signalPresent).toBe(true);
    expect(sweeps[0]?.signalAborted).toBe(false);

    // Stamping after the pass is what lets a killed alarm retry promptly instead of
    // waiting out the interval it never actually used.
    const stamped = await lastSweepAt();
    expect(stamped).toBeDefined();
    expect(stamped ?? 0).toBeGreaterThanOrEqual(sweeps[0]?.finishedAt ?? Number.POSITIVE_INFINITY);
  });

  it('skips the sweep while the interval has not elapsed', async () => {
    await runPass();
    expect(sweeps).toHaveLength(1);

    await runPass();
    expect(sweeps).toHaveLength(1);
  });

  it('runs again once the interval has elapsed', async () => {
    await runPass();
    expect(sweeps).toHaveLength(1);

    await runInDurableObject(stub(), (_instance, state) =>
      state.storage.put(LAST_DELIVERY_RETRY_KEY, Date.now() - DELIVERY_RETRY_INTERVAL_MS - 1_000),
    );
    await runPass();

    expect(sweeps).toHaveLength(2);
  });
});
