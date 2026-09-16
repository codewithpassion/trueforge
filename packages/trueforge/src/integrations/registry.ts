import { IntegrationTypeSchema, type IntegrationType } from '../schemas/integration';
import { SlackChannelAdapter } from './slack/SlackChannelAdapter';
import type { ChannelAdapter } from './types';

/**
 * Channel adapters keyed by manifest type. Built from code at startup — nothing is
 * loaded dynamically, so adding a channel means adding an adapter module here.
 */
export type IntegrationAdapterRegistry = ReadonlyMap<IntegrationType, ChannelAdapter>;

/** Adapters hold no per-request state, so callers on hot paths may build the map freely. */
export function createIntegrationAdapters(): IntegrationAdapterRegistry {
  return new Map<IntegrationType, ChannelAdapter>([[IntegrationTypeSchema.enum.slack, new SlackChannelAdapter()]]);
}
