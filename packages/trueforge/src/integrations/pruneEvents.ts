import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ControlLoop } from '../controller/Controller';
import type { IIntegrationStore } from '../db/integrationStore';

/** Dedupe rows only have to outlive a channel's own retry window. */
export const INTEGRATION_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** The dedupe log grows slowly, so one sweep an hour is enough. */
export const INTEGRATION_EVENT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const INTEGRATION_EVENT_PRUNE_LOOP_NAME = 'integration-event-prune';

/** Drops dedupe rows past the retention window. Never throws; a failed sweep retries next pass. */
export async function pruneIntegrationEvents<TTransaction>(input: {
  integrationStore: IIntegrationStore<TTransaction>;
  logger: Logger;
}): Promise<void> {
  try {
    const removed = await input.integrationStore.pruneEvents({
      before: new Date(Date.now() - INTEGRATION_EVENT_RETENTION_MS),
    });
    if (removed > 0) {
      input.logger.debug('Pruned integration events', { removed });
    }
  } catch (error) {
    input.logger.warn('Could not prune integration events', extractErrorLogFields(error));
  }
}

export function integrationEventPruneLoop<TTransaction>(params: {
  integrationStore: IIntegrationStore<TTransaction>;
  logger: Logger;
}): ControlLoop {
  return {
    name: INTEGRATION_EVENT_PRUNE_LOOP_NAME,
    intervalMs: INTEGRATION_EVENT_PRUNE_INTERVAL_MS,
    tick: () => pruneIntegrationEvents(params),
  };
}
