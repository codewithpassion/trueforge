import type { IntegrationAdapterRegistry } from '../../../src/integrations/registry';
import type { ChannelAdapter, Delivery, InboundResult } from '../../../src/integrations/types';

export interface FakeChannelAdapter {
  adapters: IntegrationAdapterRegistry;
  /** Every delivery the adapter was asked to post, in order. */
  delivered: Delivery[];
}

/**
 * A `slack` adapter that records deliveries instead of posting them, so a test can count
 * how often the notifier fired. `receive` is unused until the real adapter lands.
 */
export function fakeChannelAdapter(options: { deliver?: () => { ok: false; error: string } } = {}): FakeChannelAdapter {
  const delivered: Delivery[] = [];
  const adapter: ChannelAdapter = {
    type: 'slack',
    receive: (): Promise<InboundResult> => Promise.resolve({ type: 'ignore', reason: 'fake adapter' }),
    deliver: input => {
      delivered.push(input.delivery);
      return Promise.resolve(options.deliver?.() ?? { ok: true });
    },
  };
  return { adapters: new Map([['slack', adapter]]), delivered };
}
