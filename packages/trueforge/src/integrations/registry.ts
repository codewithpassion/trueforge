import type { IntegrationType } from '../schemas/integration';
import type { ChannelAdapter } from './types';

/**
 * Channel adapters keyed by manifest type. Built from code at startup — nothing is
 * loaded dynamically, so adding a channel means adding an adapter module here.
 */
export type IntegrationAdapterRegistry = ReadonlyMap<IntegrationType, ChannelAdapter>;

/** No channel adapter ships yet, so every ingress request answers 501. */
export function createIntegrationAdapters(): IntegrationAdapterRegistry {
  return new Map<IntegrationType, ChannelAdapter>();
}
