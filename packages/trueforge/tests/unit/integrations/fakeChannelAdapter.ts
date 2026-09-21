import type { IntegrationAdapterRegistry } from '../../../src/integrations/registry';
import type {
  ChannelAdapter,
  Delivery,
  DeliveryResult,
  InboundInteractionResult,
  InboundResult,
  InteractionOutcome,
} from '../../../src/integrations/types';

export interface FakeChannelAdapter {
  adapters: IntegrationAdapterRegistry;
  adapter: ChannelAdapter;
  /** Every delivery the adapter was asked to post, in order. */
  delivered: Delivery[];
  /** The caller deadline handed to each delivery, in the same order. */
  signals: (AbortSignal | undefined)[];
  /** Every out-of-band line the adapter was asked to post, in order. */
  notices: string[];
  /** Every interaction reply the adapter was asked to post, in order. */
  settlements: InteractionOutcome[];
}

/**
 * A `slack` adapter that records what it was asked to post instead of posting it, so a test can
 * count how often the layer fired. `receive` is covered by the real adapter's own tests.
 */
export function fakeChannelAdapter(options: { deliver?: () => DeliveryResult } = {}): FakeChannelAdapter {
  const delivered: Delivery[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const notices: string[] = [];
  const settlements: InteractionOutcome[] = [];
  const adapter: ChannelAdapter = {
    type: 'slack',
    receive: (): Promise<InboundResult> => Promise.resolve({ type: 'ignore', reason: 'fake adapter' }),
    receiveInteraction: (): Promise<InboundInteractionResult> =>
      Promise.resolve({ type: 'ignore', reason: 'fake adapter' }),
    deliver: input => {
      delivered.push(input.delivery);
      signals.push(input.signal);
      return Promise.resolve(options.deliver?.() ?? { ok: true });
    },
    notice: input => {
      notices.push(input.text);
      return Promise.resolve({ ok: true });
    },
    settleInteraction: input => {
      settlements.push(input.outcome);
      return Promise.resolve({ ok: true });
    },
  };
  return { adapters: new Map([['slack', adapter]]), adapter, delivered, signals, notices, settlements };
}
