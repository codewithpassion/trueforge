import type { SessionHandle, TerminalTurnState } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { IIntegrationStore, IntegrationDeliveryRecord, IntegrationRecord } from '../db/integrationStore';
import type { IScheduleStore } from '../db/scheduleStore';
import { connectedSlackManifest, type IntegrationNotificationRule } from '../schemas/integration';
import { newId } from '../utils/id';
import { buildDeliveryContent } from './deliveryContent';
import { claimDeadlineAt, firstAttemptDueAt, MAX_DELIVERY_ATTEMPTS, nextAttemptAt } from './deliverySchedule';
import type { IntegrationAdapterRegistry } from './registry';
import { slackChannelKey } from './slack/events';
import type { DeliveryContent } from './types';

export interface TurnCompletionNotifierDeps<TTransaction> {
  integrationStore: IIntegrationStore<TTransaction>;
  /** Notification rules name a schedule; the session source only carries its id. */
  scheduleStore: Pick<IScheduleStore<TTransaction>, 'getSchedule'>;
  adapters: IntegrationAdapterRegistry;
  logger: Logger;
}

/** A finished schedule run counts as a success only when the agent actually answered. */
function scheduleOutcome(state: TerminalTurnState): 'success' | 'failure' {
  return state.status === 'done' ? 'success' : 'failure';
}

function ruleMatches(input: {
  rule: IntegrationNotificationRule;
  schedule_name: string;
  outcome: 'success' | 'failure';
}): boolean {
  const { rule } = input;
  return rule.schedule_name === input.schedule_name && (rule.outcome === 'any' || rule.outcome === input.outcome);
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
 * A turn from a schedule takes the other branch: nothing is owed in advance, so the rules of
 * this tenant's connected integrations decide what to enqueue, and the same claim-first
 * outbox carries it.
 *
 * Never throws: the drain must not fail because a channel is unreachable.
 */
export class TurnCompletionNotifier<TTransaction> {
  readonly #deps: TurnCompletionNotifierDeps<TTransaction>;

  constructor(deps: TurnCompletionNotifierDeps<TTransaction>) {
    this.#deps = deps;
  }

  async deliverForTurn(input: { session: SessionHandle; turn_id: string }): Promise<void> {
    const source = input.session.record.source;
    if (source?.type === 'schedule') {
      await this.#deliverScheduleResult({ ...input, schedule_id: source.id });
      return;
    }
    if (source?.type !== 'integration') {
      return;
    }
    const { session, turn_id: turnId } = input;
    const { integrationStore, logger } = this.#deps;
    try {
      const conversationKey = source.conversation_key;
      if (
        (await integrationStore.getPendingDelivery({ turn_id: turnId, conversation_key: conversationKey })) ===
        undefined
      ) {
        return;
      }
      const turn = await session.getTurn(turnId);
      const turnState = turn?.state;
      if (turn === undefined || turnState === undefined || turnState.status === 'running') {
        // Not finished here; the drain that owns it delivers.
        return;
      }
      if (turnState.status === 'error') {
        // The channel gets a generic line, so the provider's own message is only readable here.
        logger.warn('Integration turn failed', { sessionId: session.session_id, turnId, reason: turnState.message });
      }

      // Past this point exactly one caller holds the row, so the channel is posted to once.
      const delivery = await integrationStore.claimDelivery({
        turn_id: turnId,
        conversation_key: conversationKey,
        next_attempt_at: claimDeadlineAt(),
      });
      if (delivery === undefined) {
        return;
      }
      await this.deliverClaimed({
        delivery,
        content: await buildDeliveryContent({ turn, turn_id: turnId, state: turnState }),
      });
    } catch (error) {
      logger.error('Integration delivery failed', {
        sessionId: session.session_id,
        turnId,
        ...extractErrorLogFields(error),
      });
    }
  }

  /**
   * Fans a finished schedule run out to the channels its tenant's rules name. One delivery per
   * matching channel: two rules pointing at the same channel collapse onto the one outbox row
   * the unique `(turn_id, conversation_key)` key allows, so nobody is told twice.
   *
   * Statements added per finished schedule turn: one `listIntegrations`; then, only when some
   * connected integration carries a rule, one `getSchedule`, one turn read, and per matching
   * channel an enqueue, a claim and a settle.
   */
  async #deliverScheduleResult(input: { session: SessionHandle; turn_id: string; schedule_id: string }): Promise<void> {
    const { session, turn_id: turnId } = input;
    const { integrationStore, scheduleStore, logger } = this.#deps;
    try {
      const tenantId = session.record.tenant_id;
      const integrations = (await integrationStore.listIntegrations({ tenant_id: tenantId })).filter(
        // A pending integration has no credentials, so it could not post if it tried.
        candidate =>
          connectedSlackManifest(candidate.manifest) !== undefined && candidate.manifest.notification_rules.length > 0,
      );
      if (integrations.length === 0) {
        return;
      }
      const schedule = await scheduleStore.getSchedule({ tenant_id: tenantId, id: input.schedule_id });
      if (schedule === undefined) {
        return;
      }
      const turn = await session.getTurn(turnId);
      const turnState = turn?.state;
      if (turn === undefined || turnState === undefined || turnState.status === 'running') {
        return;
      }
      const outcome = scheduleOutcome(turnState);
      const content = await buildDeliveryContent({ turn, turn_id: turnId, state: turnState });

      for (const integration of integrations) {
        const channelIds = new Set(
          integration.manifest.notification_rules
            .filter(rule => ruleMatches({ rule, schedule_name: schedule.name, outcome }))
            .map(rule => rule.channel_id),
        );
        for (const channelId of channelIds) {
          await this.#deliverToChannel({ integration, channel_id: channelId, session, turn_id: turnId, content });
        }
      }
    } catch (error) {
      logger.error('Schedule notification failed', {
        sessionId: session.session_id,
        turnId,
        ...extractErrorLogFields(error),
      });
    }
  }

  async #deliverToChannel(input: {
    integration: IntegrationRecord;
    channel_id: string;
    session: SessionHandle;
    turn_id: string;
    content: DeliveryContent;
  }): Promise<void> {
    const { integration } = input;
    const teamId = connectedSlackManifest(integration.manifest)?.team_id;
    if (teamId === undefined) {
      return;
    }
    const conversationKey = slackChannelKey({ teamId, channelId: input.channel_id });
    const externalId = input.session.record.external_id;
    if (externalId === null) {
      return;
    }
    const { integrationStore } = this.#deps;
    const { enqueued } = await integrationStore.enqueueDelivery({
      id: newId(),
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      conversation_key: conversationKey,
      turn_id: input.turn_id,
      session_external_id: externalId,
      next_attempt_at: firstAttemptDueAt(),
    });
    if (!enqueued) {
      // Another pass already owes this channel this turn; it will post or the sweep will.
      return;
    }
    const delivery = await integrationStore.claimDelivery({
      turn_id: input.turn_id,
      conversation_key: conversationKey,
      next_attempt_at: claimDeadlineAt(),
    });
    if (delivery === undefined) {
      return;
    }
    await this.deliverClaimed({ delivery, content: input.content });
  }

  /**
   * Posts a row the caller already holds. Both the drain hook and the retry sweep end here, so
   * the settle rules — sent, released for another attempt, or given up on — live in one place.
   */
  async deliverClaimed(input: {
    delivery: IntegrationDeliveryRecord;
    content: DeliveryContent;
    /** The caller's deadline, handed to the channel so a slow post cannot outlive the pass. */
    signal?: AbortSignal | undefined;
    now?: (() => number) | undefined;
  }): Promise<void> {
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.ok) {
      await integrationStore.markDeliverySent({ id: delivery.id, attempts: delivery.attempts });
      return;
    }
    if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.#giveUp({ delivery, error: result.error });
      return;
    }
    await integrationStore.releaseDelivery({
      id: delivery.id,
      attempts: delivery.attempts,
      error: result.error,
      next_attempt_at: nextAttemptAt({
        attempts: delivery.attempts,
        retryAfterMs: result.retry_after_ms,
        ...(input.now === undefined ? {} : { nowMs: input.now() }),
      }),
    });
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
      attempts: input.delivery.attempts,
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
