import { EventType, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import type { SequencedEvent } from '../runtime/event-subscription';

/** Our own serialized events read back from storage or RPC: a shape check, not schema validation. */
export function isSequencedTurnStreamingEvent(value: unknown): value is SequencedEvent<TurnStreamingEvent> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'sequence_number' in value &&
    typeof value.sequence_number === 'number'
  );
}

/**
 * Newline-delimited JSON over a byte stream, because RPC carries only byte streams. Ends after
 * `turn.done`; cancelling the stream aborts the underlying poll.
 */
export function encodeTurnEvents(
  open: (signal: AbortSignal) => AsyncGenerator<SequencedEvent<TurnStreamingEvent>, void, unknown>,
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const events = open(abort.signal);
  const encoder = new TextEncoder();
  const finish = async (): Promise<void> => {
    abort.abort();
    await events.return(undefined);
  };
  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      const next = await events.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      if (next.value.type === EventType.TURN_DONE) {
        await finish();
        controller.close();
      }
    },
    cancel: finish,
  });
}

/** Reverses {@link encodeTurnEvents}; aborting `signal` or returning early cancels the byte stream. */
export async function* decodeTurnEvents({
  stream,
  signal,
}: {
  stream: ReadableStream<Uint8Array>;
  signal: AbortSignal;
}): AsyncGenerator<SequencedEvent<TurnStreamingEvent>, void, unknown> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = (): void => {
    void reader.cancel();
  };
  signal.addEventListener('abort', cancel, { once: true });
  let buffered = '';
  try {
    for (;;) {
      if (signal.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffered += value;
      for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
        const event: unknown = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (!isSequencedTurnStreamingEvent(event)) {
          throw new Error('Session Durable Object sent a malformed turn event');
        }
        yield event;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    // Releases the RPC stream so the Durable Object stops polling.
    await reader.cancel();
  }
}
