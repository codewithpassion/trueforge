/**
 * Hands a producer's items to one consumer, one at a time: `offer` resolves only once the consumer has
 * pulled past the item, so a slow consumer slows the producer. When the consumer stops (returns early,
 * throws, or `signal` aborts), every pending and later `offer` resolves at once, so the producer
 * always runs to its end.
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
    produced: boolean;
    consumerGone: boolean;
    wake: (() => void) | undefined;
  } = { offered: undefined, produced: false, consumerGone: false, wake: undefined };

  const notify = (): void => {
    const wake = state.wake;
    state.wake = undefined;
    wake?.();
  };
  const stopConsuming = (): void => {
    state.consumerGone = true;
    state.offered?.taken();
    state.offered = undefined;
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
  }).finally(() => {
    state.produced = true;
    notify();
  });

  return (async function* () {
    try {
      for (;;) {
        if (state.consumerGone) {
          return;
        }
        const offered = state.offered;
        if (offered !== undefined) {
          state.offered = undefined;
          try {
            yield offered.item;
          } finally {
            offered.taken();
          }
          continue;
        }
        if (state.produced) {
          return;
        }
        await new Promise<void>(resolve => {
          state.wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener('abort', stopConsuming);
      stopConsuming();
    }
  })();
}
