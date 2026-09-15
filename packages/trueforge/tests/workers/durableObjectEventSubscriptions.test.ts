import { runInDurableObject } from 'cloudflare:test';
import { StreamGoneError, type EventSubscription, type SequencedEvent } from '../../src/runtime/event-subscription';
import { DurableObjectEventSubscriptions } from '../../src/workers/durableObjectEventSubscriptions';
import { sessionStub } from './harness';

interface TestEvent {
  type: string;
  index: number;
}

function isTestEvent(value: unknown): value is SequencedEvent<TestEvent> {
  return (
    typeof value === 'object' && value !== null && 'type' in value && 'index' in value && 'sequence_number' in value
  );
}

function event(index: number): TestEvent {
  return { type: 'test.event', index };
}

/** Runs `body` inside a SessionDO instance, against its SQLite storage. */
function withSubscriptions<R>(
  body: (input: { subscriptions: DurableObjectEventSubscriptions<TestEvent>; sql: SqlStorage }) => Promise<R>,
): Promise<R> {
  return runInDurableObject(sessionStub(`event-subscription-${crypto.randomUUID()}`), (_instance, state) =>
    body({
      subscriptions: new DurableObjectEventSubscriptions({ sql: state.storage.sql, isEvent: isTestEvent }),
      sql: state.storage.sql,
    }),
  );
}

async function take(
  subscription: EventSubscription<TestEvent>,
  input: { count: number; after: number | undefined },
): Promise<SequencedEvent<TestEvent>[]> {
  const abort = new AbortController();
  const generator = subscription.poll(input.after, { signal: abort.signal });
  const received: SequencedEvent<TestEvent>[] = [];
  try {
    for await (const item of generator) {
      received.push(item);
      if (received.length >= input.count) {
        break;
      }
    }
  } finally {
    abort.abort();
    await generator.return(undefined);
  }
  return received;
}

describe('DurableObjectEventSubscriptions', () => {
  it('assigns dense sequence numbers from storage and replays them in order', async () => {
    await withSubscriptions(async ({ subscriptions }) => {
      const stream = subscriptions.get('s');
      const sequenceNumbers = [];
      for (let index = 0; index < 3; index += 1) {
        sequenceNumbers.push(await stream.put(event(index), { streamTTLSeconds: 600 }));
      }
      // A fresh view of the same stream continues from what storage holds, not an in-memory counter.
      sequenceNumbers.push(await subscriptions.get('s').put(event(3)));

      expect(sequenceNumbers).toEqual([1, 2, 3, 4]);
      expect(await take(stream, { count: 4, after: undefined })).toEqual(
        [0, 1, 2, 3].map(index => ({ ...event(index), sequence_number: index + 1 })),
      );
    });
  });

  it('resumes strictly after a cursor', async () => {
    await withSubscriptions(async ({ subscriptions }) => {
      const stream = subscriptions.get('s');
      for (let index = 0; index < 5; index += 1) {
        await stream.put(event(index), { streamTTLSeconds: 600 });
      }

      expect((await take(stream, { count: 3, after: 2 })).map(item => item.sequence_number)).toEqual([3, 4, 5]);
      expect(await take(stream, { count: 1, after: 0 })).toEqual([{ ...event(0), sequence_number: 1 }]);
    });
  });

  it('wakes a poller parked at the tip when an event is put', async () => {
    await withSubscriptions(async ({ subscriptions }) => {
      const stream = subscriptions.get('s');
      await stream.put(event(0), { streamTTLSeconds: 600 });

      const pending = take(stream, { count: 2, after: 1 });
      await stream.put(event(1));
      await stream.put(event(2));

      expect((await pending).map(item => item.index)).toEqual([1, 2]);
    });
  });

  it('treats a missing stream or one expiring within the threshold as gone', async () => {
    await withSubscriptions(async ({ subscriptions }) => {
      await expect(subscriptions.get('missing').assertSubscribable()).rejects.toBeInstanceOf(StreamGoneError);

      const expiringSoon = subscriptions.get('expiring-soon');
      await expiringSoon.put(event(0), { streamTTLSeconds: 30 });
      await expect(expiringSoon.assertSubscribable()).rejects.toBeInstanceOf(StreamGoneError);

      const live = subscriptions.get('live');
      await live.put(event(0), { streamTTLSeconds: 600 });
      await expect(live.assertSubscribable()).resolves.toBeUndefined();
    });
  });

  it('applies the TTL of the latest put to the whole stream', async () => {
    await withSubscriptions(async ({ subscriptions, sql }) => {
      const stream = subscriptions.get('s');
      await stream.put(event(0), { streamTTLSeconds: 600 });
      await stream.put(event(1));
      await stream.put(event(2), { streamTTLSeconds: 900 });

      const expiries = sql
        .exec<{ expires_at: number }>('SELECT DISTINCT expires_at FROM turn_events WHERE stream_id = ?', 's')
        .toArray();
      expect(expiries).toHaveLength(1);
      expect(expiries[0]?.expires_at).toBeGreaterThan(Date.now() + 800_000);
    });
  });

  it('reads an expired stream as gone and deletes expired rows', async () => {
    await withSubscriptions(async ({ subscriptions, sql }) => {
      await subscriptions.get('expired').put(event(0), { streamTTLSeconds: 600 });
      await subscriptions.get('kept').put(event(0), { streamTTLSeconds: 600 });
      sql.exec('UPDATE turn_events SET expires_at = ? WHERE stream_id = ?', Date.now() - 1, 'expired');

      await expect(take(subscriptions.get('expired'), { count: 1, after: undefined })).rejects.toBeInstanceOf(
        StreamGoneError,
      );
      subscriptions.deleteExpired(Date.now());

      const streams = sql.exec<{ stream_id: string }>('SELECT DISTINCT stream_id FROM turn_events').toArray();
      expect(streams.map(row => row.stream_id)).toEqual(['kept']);
      expect(subscriptions.nextExpiry(Date.now())).toBeGreaterThan(Date.now());
    });
  });
});
