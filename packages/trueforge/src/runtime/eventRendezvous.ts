/**
 * Hands a producer's items to one consumer, one at a time: `offer` resolves only once the consumer pulls
 * past the item, so a slow consumer slows the producer. The producer starts at once and runs to its end
 * whatever the consumer does: when the consumer stops (`return()` or `throw()`, even before its first
 * pull, or `signal` aborts, even while it holds an item), the pending `offer` and every later one
 * resolve at once. A producer rejection is thrown from the consumer's next pull; once the consumer has
 * stopped it is dropped, so the producer must report its own failures.
 */
export function eventRendezvous<T>({
  produce,
  signal,
}: {
  produce: (offer: (item: T) => Promise<void>) => Promise<void>;
  signal: AbortSignal;
}): AsyncGenerator<T, void, unknown> {
  // Fields on one object, so flags flipped by the producer are re-read after each wait.
  const state: {
    offered: { item: T; taken: () => void } | undefined;
    /** Releases the offer of the item the consumer holds between yield and its next pull. */
    held: (() => void) | undefined;
    produced: boolean;
    failure: { error: unknown } | undefined;
    consumerGone: boolean;
    wake: (() => void) | undefined;
  } = {
    offered: undefined,
    held: undefined,
    produced: false,
    failure: undefined,
    consumerGone: false,
    wake: undefined,
  };

  const notify = (): void => {
    const wake = state.wake;
    state.wake = undefined;
    wake?.();
  };
  const stopConsuming = (): void => {
    signal.removeEventListener('abort', stopConsuming);
    state.consumerGone = true;
    state.offered?.taken();
    state.offered = undefined;
    state.held?.();
    state.held = undefined;
    notify();
  };
  signal.addEventListener('abort', stopConsuming, { once: true });

  void produce(item => {
    if (state.consumerGone) {
      return Promise.resolve();
    }
    return new Promise<void>(taken => {
      state.offered = { item, taken };
      notify();
    });
  })
    .catch((error: unknown) => {
      state.failure = { error };
    })
    .finally(() => {
      state.produced = true;
      notify();
    });

  const consumer = (async function* () {
    try {
      for (;;) {
        if (state.consumerGone) {
          return;
        }
        const offered = state.offered;
        if (offered !== undefined) {
          state.offered = undefined;
          state.held = offered.taken;
          try {
            yield offered.item;
          } finally {
            state.held = undefined;
            offered.taken();
          }
          continue;
        }
        if (state.produced) {
          if (state.failure !== undefined) {
            throw state.failure.error;
          }
          return;
        }
        await new Promise<void>(resolve => {
          state.wake = resolve;
        });
      }
    } finally {
      stopConsuming();
    }
  })();

  // A generator that has not started skips its body on return() or throw(), so stop consuming here too.
  const events: AsyncGenerator<T, void, unknown> = {
    next: (...args) => consumer.next(...args),
    return: value => {
      stopConsuming();
      return consumer.return(value);
    },
    throw: (error: unknown) => {
      stopConsuming();
      return consumer.throw(error);
    },
    [Symbol.asyncIterator]: () => events,
    [Symbol.asyncDispose]: async () => {
      await events.return(undefined);
    },
  };
  return events;
}
