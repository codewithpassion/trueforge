import type { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ControlLoop } from '../controller/Controller';
import type { IIntegrationStore, IntegrationDeliveryRecord } from '../db/integrationStore';
import { buildDeliveryContent, deliveryIsInteractive } from './deliveryContent';
import { claimDeadlineAt, MAX_DELIVERY_ATTEMPTS } from './deliverySchedule';
import type { TurnCompletionNotifier } from './TurnCompletionNotifier';

/** Retries are rare, so the sweep is cheap and does not need to run often. */
export const DELIVERY_RETRY_INTERVAL_MS = 60 * 1000;
export const DELIVERY_RETRY_LOOP_NAME = 'integration-delivery-retry';
/** Keeps one pass bounded; the next pass takes whatever is left. */
const RETRY_BATCH_SIZE = 50;

export interface RetryIntegrationDeliveriesDeps<TTransaction> {
  integrationStore: IIntegrationStore<TTransaction>;
  sessions: Sessions;
  notifier: TurnCompletionNotifier<TTransaction>;
  logger: Logger;
  /** The caller's deadline. Checked between rows and passed to the channel, so a pass stops on time. */
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
}

/**
 * Posts replies a first attempt did not deliver: `pending` rows past their backoff and `sending`
 * rows whose holder ran out of time. The store returns only rows already due, in due order. The
 * claim is guarded on the attempt count read here, so two sweeps racing a row post once.
 *
 * Never throws; a failed pass retries next time.
 */
export async function retryIntegrationDeliveries<TTransaction>(
  deps: RetryIntegrationDeliveriesDeps<TTransaction>,
): Promise<void> {
  const { integrationStore, logger, signal } = deps;
  const now = deps.now ?? Date.now;
  try {
    const rows = await integrationStore.listRetryableDeliveries({
      before: new Date(now()),
      limit: RETRY_BATCH_SIZE,
    });
    for (const row of rows) {
      // A pass that is out of time leaves the rest; they are still due on the next one.
      if (signal?.aborted === true) {
        logger.debug('Integration delivery sweep stopped early', { remaining: rows.length - rows.indexOf(row) });
        return;
      }
      await retryOneDelivery({ ...deps, row, now });
    }
  } catch (error) {
    logger.warn('Could not sweep integration deliveries', extractErrorLogFields(error));
  }
}

async function retryOneDelivery<TTransaction>(
  input: RetryIntegrationDeliveriesDeps<TTransaction> & { row: IntegrationDeliveryRecord; now: () => number },
): Promise<void> {
  const { row, integrationStore, sessions, notifier, logger, signal, now } = input;
  try {
    const deadline = claimDeadlineAt(now());
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
      const claimed = await integrationStore.claimDeliveryForRetry({
        id: row.id,
        attempts: row.attempts,
        next_attempt_at: deadline,
      });
      if (claimed !== undefined) {
        await integrationStore.markDeliveryFailed({
          id: claimed.id,
          attempts: claimed.attempts,
          error: row.last_error ?? 'Out of delivery attempts',
        });
      }
      return;
    }

    // A rule delivery posts to a channel the session was never keyed by, so the row carries the
    // session it reports on rather than deriving it from where the message goes.
    const session = await sessions.getByExternalId({
      tenant_id: row.tenant_id,
      external_id: row.session_external_id,
    });
    const turn = session === undefined ? undefined : await session.getTurn(row.turn_id);
    const turnState = turn?.state;
    if (turn === undefined || turnState === undefined) {
      logger.warn('Integration delivery has no turn to report', { deliveryId: row.id, turnId: row.turn_id });
      const orphan = await integrationStore.claimDeliveryForRetry({
        id: row.id,
        attempts: row.attempts,
        next_attempt_at: deadline,
      });
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

    const claimed = await integrationStore.claimDeliveryForRetry({
      id: row.id,
      attempts: row.attempts,
      next_attempt_at: deadline,
    });
    if (claimed === undefined) {
      return;
    }
    await notifier.deliverClaimed({
      delivery: claimed,
      content: await buildDeliveryContent({
        turn,
        turn_id: row.turn_id,
        state: turnState,
        // A rule delivery's channel is not the session's conversation, so it gets no buttons
        // on a retry either — the same comparison the first attempt made.
        interactive: deliveryIsInteractive(row),
      }),
      signal,
      now,
    });
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
    tick: signal => retryIntegrationDeliveries({ ...deps, signal }),
  };
}
