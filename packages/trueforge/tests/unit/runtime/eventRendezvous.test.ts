import { eventRendezvous } from '../../../src/runtime/eventRendezvous';

/** Lets every queued promise continuation run. */
function settle(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

function countingProducer(total: number) {
  const offered: number[] = [];
  let finish: () => void = () => undefined;
  const finished = new Promise<void>(resolve => {
    finish = resolve;
  });
  const produce = async (offer: (item: number) => Promise<void>): Promise<void> => {
    for (let item = 1; item <= total; item += 1) {
      await offer(item);
      offered.push(item);
    }
    finish();
  };
  return { produce, offered, finished };
}

describe('eventRendezvous', () => {
  it('holds the producer until the consumer pulls past each item', async () => {
    const { produce, offered } = countingProducer(3);
    const events = eventRendezvous({ produce, signal: new AbortController().signal });

    expect(await events.next()).toEqual({ done: false, value: 1 });
    await settle();
    expect(offered).toEqual([]);

    expect(await events.next()).toEqual({ done: false, value: 2 });
    await settle();
    expect(offered).toEqual([1]);

    expect(await events.next()).toEqual({ done: false, value: 3 });
    expect(await events.next()).toEqual({ done: true, value: undefined });
    expect(offered).toEqual([1, 2, 3]);
  });

  it('lets the producer finish when the consumer returns early', async () => {
    const { produce, offered, finished } = countingProducer(5);
    const events = eventRendezvous({ produce, signal: new AbortController().signal });

    for await (const item of events) {
      expect(item).toBe(1);
      break;
    }
    await finished;

    expect(offered).toEqual([1, 2, 3, 4, 5]);
  });

  it('lets the producer finish when the consumer throws', async () => {
    const { produce, offered, finished } = countingProducer(4);
    const events = eventRendezvous({ produce, signal: new AbortController().signal });

    await expect(
      (async () => {
        for await (const item of events) {
          throw new Error(`write failed at ${String(item)}`);
        }
      })(),
    ).rejects.toThrow('write failed at 1');
    await finished;

    expect(offered).toEqual([1, 2, 3, 4]);
  });

  it('ends a parked consumer and releases the producer when the signal aborts', async () => {
    const abort = new AbortController();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const offered: string[] = [];
    const produced = (async () => {
      await gate;
    })();
    const events = eventRendezvous<string>({
      produce: async offer => {
        await produced;
        await offer('late');
        offered.push('late');
      },
      signal: abort.signal,
    });

    const parked = events.next();
    abort.abort();
    expect(await parked).toEqual({ done: true, value: undefined });

    release();
    await settle();
    expect(offered).toEqual(['late']);
  });
});
