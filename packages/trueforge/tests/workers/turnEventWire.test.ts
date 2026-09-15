import { EventType, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { runInDurableObject } from 'cloudflare:test';
import { DurableObjectEventSubscriptions } from '../../src/workers/durableObjectEventSubscriptions';
import { encodeTurnEvents, isSequencedTurnStreamingEvent } from '../../src/workers/turnEventWire';
import { sessionStub } from './harness';

const turnCreated: TurnStreamingEvent = {
  type: EventType.TURN_CREATED,
  id: 'evt_created',
  turn_id: 'turn-wire',
  previous_turn_id: null,
  state: { status: 'running' },
  created_at: '2026-01-01T00:00:00.000Z',
  thread_id: null,
};

describe('encodeTurnEvents', () => {
  it('ends the Durable Object poll when the reader cancels the stream', async () => {
    await runInDurableObject(sessionStub(`turn-event-wire-${crypto.randomUUID()}`), async (_instance, state) => {
      const subscriptions = new DurableObjectEventSubscriptions<TurnStreamingEvent>({
        sql: state.storage.sql,
        isEvent: isSequencedTurnStreamingEvent,
      });
      const subscription = subscriptions.get('wire');
      await subscription.put(turnCreated, { streamTTLSeconds: 600 });
      const poll = { finished: false, aborted: false };
      const stream = encodeTurnEvents(signal =>
        (async function* () {
          try {
            yield* subscription.poll(undefined, { signal });
          } finally {
            poll.finished = true;
            poll.aborted = signal.aborted;
          }
        })(),
      );
      const reader = stream.getReader();

      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(EventType.TURN_CREATED);
      // The next read parks the poll at the tip of the stream.
      const parked = reader.read();
      await reader.cancel();

      expect((await parked).done).toBe(true);
      expect(poll).toEqual({ finished: true, aborted: true });
    });
  });
});
