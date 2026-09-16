import type { SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { IIntegrationStore } from '../db/integrationStore';
import { buildDeliveryContent } from './deliveryContent';
import type { IntegrationAdapterRegistry } from './registry';

export interface TurnCompletionNotifierDeps<TTransaction> {
  integrationStore: IIntegrationStore<TTransaction>;
  adapters: IntegrationAdapterRegistry;
  logger: Logger;
}

/**
 * Posts the reply owed for a finished turn.
 *
 * Runs after the turn's event drain settles — in `turnRunner` on Node, inside the
 * alarm invocation that holds the turn on Workers — and again right after the router
 * writes the outbox row, which covers a turn that finished before that write landed.
 * The outbox `pending` guard is what makes both paths deliver at most once.
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
    const { integrationStore, adapters, logger } = this.#deps;
    try {
      const delivery = await integrationStore.getPendingDelivery({ turn_id: turnId });
      if (delivery === undefined) {
        return;
      }
      const turn = await session.getTurn(turnId);
      const turnState = turn?.state;
      if (turnState === undefined || turnState.status === 'running') {
        // Not finished here; the drain that owns it delivers.
        return;
      }

      const integration = await integrationStore.getIntegrationById({ id: delivery.integration_id });
      if (integration === undefined) {
        await this.#fail({ id: delivery.id, error: 'Integration was disconnected', turnId });
        return;
      }
      const adapter = adapters.get(integration.type);
      if (adapter === undefined) {
        await this.#fail({
          id: delivery.id,
          error: `No adapter for integration type ${integration.type}`,
          turnId,
        });
        return;
      }

      const result = await adapter.deliver({
        manifest: integration.manifest,
        delivery: {
          id: delivery.id,
          conversation_key: delivery.conversation_key,
          turn_id: turnId,
          content: buildDeliveryContent(turnState),
        },
      });
      if (result.ok) {
        await integrationStore.markDeliverySent({ id: delivery.id });
        return;
      }
      await this.#fail({ id: delivery.id, error: result.error, turnId });
    } catch (error) {
      logger.error('Integration delivery failed', {
        sessionId: session.session_id,
        turnId,
        ...extractErrorLogFields(error),
      });
    }
  }

  async #fail(input: { id: string; error: string; turnId: string }): Promise<void> {
    const settled = await this.#deps.integrationStore.markDeliveryFailed({ id: input.id, error: input.error });
    this.#deps.logger.warn('Integration delivery gave up', {
      deliveryId: input.id,
      turnId: input.turnId,
      attempts: settled?.attempts,
      reason: input.error,
    });
  }
}
