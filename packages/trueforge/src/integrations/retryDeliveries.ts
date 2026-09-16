import type { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ControlLoop } from '../controller/Controller';
import type { IIntegrationStore, IntegrationDeliveryRecord } from '../db/integrationStore';
import { toSessionExternalId } from './conversationKey';
import { buildDeliveryContent } from './deliveryContent';
import { MAX_DELIVERY_ATTEMPTS, type TurnCompletionNotifier } from './TurnCompletionNotifier';

/** Backoff for the first retry; each further attempt doubles it. */
export const DELIVERY_RETRY_BASE_MS = 30 * 1000;
export const DELIVERY_RETRY_MAX_BACKOFF_MS = 15 * 60 * 1000;
/**
 * How long a claimed row may sit in `sending` before it is treated as stranded. It only has to
 * outlast one post, and the adapter's own rate-limit wait is capped at ten seconds.
 */
export const DELIVERY_SENDING_TIMEOUT_MS = 5 * 60 * 1000;
/** Retries are rare, so the sweep is cheap and does not need to run often. */
export const DELIVERY_RETRY_INTERVAL_MS = 60 * 1000;
export const DELIVERY_RETRY_LOOP_NAME = 'integration-delivery-retry';
/** Keeps one pass bounded; the next pass takes whatever is left. */
const RETRY_BATCH_SIZE = 50;

export function deliveryRetryBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(DELIVERY_RETRY_BASE_MS * 2 ** exponent, DELIVERY_RETRY_MAX_BACKOFF_MS);
}

/** When a row becomes the sweep's to take: after its backoff, or after a claim was stranded. */
function dueAtMs(row: IntegrationDeliveryRecord): number {
  const updatedAt = Date.parse(row.updated_at);
  return updatedAt + (row.status === 'sending' ? DELIVERY_SENDING_TIMEOUT_MS : deliveryRetryBackoffMs(row.attempts));
}

export interface RetryIntegrationDeliveriesDeps<TTransaction> {
  integrationStore: IIntegrationStore<TTransaction>;
  sessions: Sessions;
  notifier: TurnCompletionNotifier<TTransaction>;
  logger: Logger;
}

/**
 * Posts replies a first attempt did not deliver: `pending` rows whose backoff has passed, and
 * `sending` rows a process stopped holding. The claim is guarded on the attempt count read here,
 * so two sweeps racing the same row post once. Never throws; a failed pass retries next time.
 */
export async function retryIntegrationDeliveries<TTransaction>(
  deps: RetryIntegrationDeliveriesDeps<TTransaction>,
): Promise<void> {
  const { integrationStore, sessions, notifier, logger } = deps;
  try {
    const now = Date.now();
    const rows = await integrationStore.listRetryableDeliveries({
      // Nothing is ever due sooner than one backoff step, so the cheapest cutoff is that.
      before: new Date(now - DELIVERY_RETRY_BASE_MS),
      limit: RETRY_BATCH_SIZE,
    });
    for (const row of rows) {
      if (now < dueAtMs(row)) {
        continue;
      }
      await retryOneDelivery({ row, integrationStore, sessions, notifier, logger });
    }
  } catch (error) {
    logger.warn('Could not sweep integration deliveries', extractErrorLogFields(error));
  }
}

async function retryOneDelivery<TTransaction>(input: {
  row: IntegrationDeliveryRecord;
  integrationStore: IIntegrationStore<TTransaction>;
  sessions: Sessions;
  notifier: TurnCompletionNotifier<TTransaction>;
  logger: Logger;
}): Promise<void> {
  const { row, integrationStore, sessions, notifier, logger } = input;
  try {
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
      const claimed = await integrationStore.claimDeliveryForRetry({ id: row.id, attempts: row.attempts });
      if (claimed !== undefined) {
        await integrationStore.markDeliveryFailed({
          id: claimed.id,
          attempts: claimed.attempts,
          error: row.last_error ?? 'Out of delivery attempts',
        });
      }
      return;
    }

    // The row names its conversation, not its session; the conversation key is the session's external id.
    const session = await sessions.getByExternalId({
      tenant_id: row.tenant_id,
      external_id: await toSessionExternalId(row.conversation_key),
    });
    const turnState = session === undefined ? undefined : (await session.getTurn(row.turn_id))?.state;
    if (turnState === undefined) {
      logger.warn('Integration delivery has no turn to report', { deliveryId: row.id, turnId: row.turn_id });
      const orphan = await integrationStore.claimDeliveryForRetry({ id: row.id, attempts: row.attempts });
      if (orphan !== undefined) {
        await integrationStore.markDeliveryFailed({
          id: orphan.id,
          attempts: orphan.attempts,
          error: 'Turn is no longer readable',
        });
      }
      return;
    }
    if (turnState.status === 'running') {
      // Still in flight; the drain that owns it delivers.
      return;
    }

    const claimed = await integrationStore.claimDeliveryForRetry({ id: row.id, attempts: row.attempts });
    if (claimed === undefined) {
      return;
    }
    await notifier.deliverClaimed({ delivery: claimed, content: buildDeliveryContent(turnState) });
  } catch (error) {
    logger.warn('Integration delivery retry failed', { deliveryId: row.id, ...extractErrorLogFields(error) });
  }
}

export function integrationDeliveryRetryLoop<TTransaction>(
  deps: RetryIntegrationDeliveriesDeps<TTransaction>,
): ControlLoop {
  return {
    name: DELIVERY_RETRY_LOOP_NAME,
    intervalMs: DELIVERY_RETRY_INTERVAL_MS,
    tick: () => retryIntegrationDeliveries(deps),
  };
}
