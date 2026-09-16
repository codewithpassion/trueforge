import type { SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { IIntegrationStore, IntegrationDeliveryRecord } from '../db/integrationStore';
import { buildDeliveryContent } from './deliveryContent';
import type { IntegrationAdapterRegistry } from './registry';
import type { DeliveryContent } from './types';

/** How many posts one reply is worth before the outbox row is given up on. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface TurnCompletionNotifierDeps<TTransaction> {
  integrationStore: IIntegrationStore<TTransaction>;
  adapters: IntegrationAdapterRegistry;
  logger: Logger;
}

/**
 * Posts the reply owed for a finished turn.
 *
 * Runs after the turn's event drain settles — in `turnRunner` on Node, inside the alarm
 * invocation that holds the turn on Workers — and again after the router writes the outbox
 * row, which covers a turn that finished before that write landed. Those two paths run in
 * different isolates and can both see the same owed row, so the adapter is called only by
 * the caller that wins `claimDelivery`, a single guarded `pending` -> `sending` write.
 *
 * Never throws: the drain must not fail because a channel is unreachable.
 */
export class TurnCompletionNotifier<TTransaction> {
  readonly #deps: TurnCompletionNotifierDeps<TTransaction>;

  constructor(deps: TurnCompletionNotifierDeps<TTransaction>) {
    this.#deps = deps;
  }

  async deliverForTurn(input: { session: SessionHandle; turn_id: string }): Promise<void> {
    const { session, turn_id: turnId } = input;
    if (session.record.source?.type !== 'integration') {
      return;
    }
    const { integrationStore, logger } = this.#deps;
    try {
      if ((await integrationStore.getPendingDelivery({ turn_id: turnId })) === undefined) {
        return;
      }
      const turn = await session.getTurn(turnId);
      const turnState = turn?.state;
      if (turnState === undefined || turnState.status === 'running') {
        // Not finished here; the drain that owns it delivers.
        return;
      }

      // Past this point exactly one caller holds the row, so the channel is posted to once.
      const delivery = await integrationStore.claimDelivery({ turn_id: turnId });
      if (delivery === undefined) {
        return;
      }
      await this.deliverClaimed({ delivery, content: buildDeliveryContent(turnState) });
    } catch (error) {
      logger.error('Integration delivery failed', {
        sessionId: session.session_id,
        turnId,
        ...extractErrorLogFields(error),
      });
    }
  }

  /**
   * Posts a row the caller already holds. Both the drain hook and the retry sweep end here, so
   * the settle rules — sent, released for another attempt, or given up on — live in one place.
   */
  async deliverClaimed(input: { delivery: IntegrationDeliveryRecord; content: DeliveryContent }): Promise<void> {
    const { delivery, content } = input;
    const { integrationStore, adapters } = this.#deps;

    const integration = await integrationStore.getIntegrationById({ id: delivery.integration_id });
    if (integration === undefined) {
      await this.#giveUp({ delivery, error: 'Integration was disconnected' });
      return;
    }
    const adapter = adapters.get(integration.type);
    if (adapter === undefined) {
      await this.#giveUp({ delivery, error: `No adapter for integration type ${integration.type}` });
      return;
    }

    const result = await adapter.deliver({
      manifest: integration.manifest,
      delivery: {
        id: delivery.id,
        conversation_key: delivery.conversation_key,
        turn_id: delivery.turn_id,
        content,
      },
    });
    if (result.ok) {
      await integrationStore.markDeliverySent({ id: delivery.id });
      return;
    }
    if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.#giveUp({ delivery, error: result.error });
      return;
    }
    await integrationStore.releaseDelivery({ id: delivery.id, error: result.error });
    this.#deps.logger.warn('Integration delivery will be retried', {
      deliveryId: delivery.id,
      turnId: delivery.turn_id,
      attempts: delivery.attempts,
      reason: result.error,
    });
  }

  async #giveUp(input: { delivery: IntegrationDeliveryRecord; error: string }): Promise<void> {
    const settled = await this.#deps.integrationStore.markDeliveryFailed({
      id: input.delivery.id,
      error: input.error,
    });
    this.#deps.logger.warn('Integration delivery gave up', {
      deliveryId: input.delivery.id,
      turnId: input.delivery.turn_id,
      attempts: settled?.attempts,
      reason: input.error,
    });
  }
}
