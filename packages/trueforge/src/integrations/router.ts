import type { SessionHandle, Sessions } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IIntegrationStore, IntegrationRecord } from '../db/integrationStore';
import type { TurnExecutor, TurnExecutorFailure, TurnStores } from '../runtime/turnExecutor';
import { newId } from '../utils/id';
import { toSessionExternalId } from './conversationKey';
import type { TurnCompletionNotifier } from './TurnCompletionNotifier';
import type { ChannelAdapter, InboundEvent, InboundSender } from './types';

/** Longest session metadata value the session schema accepts. */
const METADATA_VALUE_MAX_LENGTH = 128;

/**
 * What a conversation hears when a message arrives while its previous one is still running.
 * Queuing the follow-up instead is a later option; starting a second turn is not, because the
 * session tip would cancel the first one.
 */
export const BUSY_CONVERSATION_NOTICE =
  'Still working on the previous message in this thread — I will reply when it is done.';

export type IntegrationRouteResult =
  | { type: 'started'; turn_id: string; session_id: string }
  /** The channel replayed an event that was already accepted; nothing ran. */
  | { type: 'duplicate' }
  /** The conversation's previous turn is still running, so the channel was told to wait. */
  | { type: 'busy'; running_turn_id: string }
  | { type: 'agent_not_found'; agent_name: string }
  | { type: 'turn_failed'; failure: TurnExecutorFailure };

export interface IntegrationRouterDeps<TTransaction> {
  integrationStore: IIntegrationStore<TTransaction>;
  sessions: Sessions;
  agentStore: IAgentStore<TTransaction>;
  turnExecutor: TurnExecutor;
  /** Stores bound to the integration's creator for the conversation's agent. */
  resolveTurnStores: (agent: AgentRecord) => TurnStores;
  notifier: TurnCompletionNotifier<TTransaction>;
  /**
   * Runs the post-start delivery flush outside the acknowledgement the channel is waiting on
   * (`waitUntil` on Workers, unawaited on Node). It must not throw.
   */
  deferDelivery: (run: () => Promise<void>) => void;
  logger: Logger;
}

/** The conversation's turn still in flight, if any. Read from the session tip, so it costs one row. */
async function runningTurnId(session: SessionHandle): Promise<string | undefined> {
  const tip = session.record.last_turn_id;
  if (tip === null) {
    return undefined;
  }
  const turn = await session.getTurn(tip);
  return turn?.state.status === 'running' ? tip : undefined;
}

/** Provenance only; it never changes what the turn is allowed to do. */
function senderMetadata(sender: InboundSender): Record<string, string> {
  return {
    'integration.sender_id': sender.id.slice(0, METADATA_VALUE_MAX_LENGTH),
    'integration.sender_name': sender.display_name.slice(0, METADATA_VALUE_MAX_LENGTH),
  };
}

/**
 * Turns a verified inbound event into a turn: dedupe, get-or-create the conversation's
 * session, start a non-streaming turn as the admin who connected the integration, and
 * record the reply owed in the outbox.
 */
export class IntegrationRouter<TTransaction> {
  readonly #deps: IntegrationRouterDeps<TTransaction>;

  constructor(deps: IntegrationRouterDeps<TTransaction>) {
    this.#deps = deps;
  }

  async route(input: {
    integration: IntegrationRecord;
    adapter: ChannelAdapter;
    event: InboundEvent;
  }): Promise<IntegrationRouteResult> {
    const { integration, adapter, event } = input;
    const { integrationStore, sessions, agentStore, turnExecutor, resolveTurnStores, notifier, logger } = this.#deps;

    const eventRowId = newId();
    const { recorded } = await integrationStore.recordEvent({
      id: eventRowId,
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      event_id: event.event_id,
    });
    if (!recorded) {
      return { type: 'duplicate' };
    }

    // Nothing ran for this event yet, so its dedupe row must not outlive a failure: keeping it
    // would make the channel's retry look like a replay and the message would be lost.
    const release = async (): Promise<void> => {
      await integrationStore.deleteEvent({ id: eventRowId });
    };

    const agentName = integration.manifest.default_agent_name;
    const agent = await agentStore.getAgent({ tenant_id: integration.tenant_id, name: agentName });
    if (agent === undefined) {
      await release();
      return { type: 'agent_not_found', agent_name: agentName };
    }

    const { session } = await sessions.getOrCreateByExternalId({
      tenant_id: integration.tenant_id,
      external_id: await toSessionExternalId(event.conversation_key),
      created_by_subject: integration.created_by_subject,
      agent: { type: 'reference', id: agent.id, name: agent.name },
      source: { type: 'integration', id: integration.id, conversation_key: event.conversation_key },
      metadata: senderMetadata(event.sender),
    });

    // A second turn would take the session tip from the first and cancel it, so a busy
    // conversation is told to wait instead. The event stays deduped: the notice is the answer.
    const running = await runningTurnId(session);
    if (running !== undefined) {
      this.#deps.deferDelivery(async () => {
        const posted = await adapter.notice({
          manifest: integration.manifest,
          conversation_key: event.conversation_key,
          text: BUSY_CONVERSATION_NOTICE,
        });
        if (!posted.ok) {
          logger.warn('Integration busy notice was not posted', {
            integrationId: integration.id,
            sessionId: session.session_id,
            reason: posted.error,
          });
        }
      });
      return { type: 'busy', running_turn_id: running };
    }

    // 'auto' continues from the session tip, so the first message starts a thread and
    // later messages in it continue the same conversation.
    const started = await turnExecutor.start({
      session,
      input: [{ type: 'user.message', content: event.text }],
      previous_turn_id: 'auto',
      userRef: integration.created_by_subject.subject_id,
      stores: resolveTurnStores(agent),
    });
    if (!started.ok) {
      await release();
      logger.warn('Integration turn could not start', {
        integrationId: integration.id,
        sessionId: session.session_id,
        code: started.code,
        message: started.message,
      });
      return { type: 'turn_failed', failure: started };
    }

    const { enqueued } = await integrationStore.enqueueDelivery({
      id: newId(),
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      conversation_key: event.conversation_key,
      turn_id: started.turn.id,
    });
    if (!enqueued) {
      logger.warn('Integration turn started without an outbox row', {
        integrationId: integration.id,
        turnId: started.turn.id,
      });
    }

    // A turn that finished before the outbox row landed has no drain left to deliver it. The
    // flush is deferred because it may post to the channel, which does not belong inside the
    // acknowledgement window; `claimDelivery` keeps it from racing the drain hook.
    this.#deps.deferDelivery(() => notifier.deliverForTurn({ session, turn_id: started.turn.id }));

    return { type: 'started', turn_id: started.turn.id, session_id: session.session_id };
  }
}
