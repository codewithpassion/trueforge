import type { SessionHandle, Sessions, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IIntegrationStore, IntegrationRecord } from '../db/integrationStore';
import type { TurnExecutor, TurnExecutorFailure, TurnStores } from '../runtime/turnExecutor';
import { newId } from '../utils/id';
import { toSessionExternalId } from './conversationKey';
import { firstAttemptDueAt } from './deliverySchedule';
import { readPendingAction, type PendingAction } from './pendingActions';
import type { TurnCompletionNotifier } from './TurnCompletionNotifier';
import type { ChannelAdapter, InboundEvent, InboundInteraction, InboundSender } from './types';

/** Longest session metadata value the session schema accepts. */
const METADATA_VALUE_MAX_LENGTH = 128;

/**
 * What a conversation hears when a message arrives while its previous one is still running.
 * Queuing the follow-up instead is a later option; starting a second turn is not, because the
 * session tip would cancel the first one.
 */
export const BUSY_CONVERSATION_NOTICE =
  'Still working on the previous message in this thread — I will reply when it is done.';

/**
 * What a conversation hears when it types instead of deciding. A tool approval is not something
 * free text can settle, and a user message sent into a thread holding tool calls is refused.
 */
export const APPROVAL_PENDING_NOTICE =
  'This thread is waiting on a tool approval — use the Approve or Deny buttons above.';

export type IntegrationRouteResult =
  | { type: 'started'; turn_id: string; session_id: string }
  /** The channel replayed an event that was already accepted; nothing ran. */
  | { type: 'duplicate' }
  /** The conversation's previous turn is still running, so the channel was told to wait. */
  | { type: 'busy'; running_turn_id: string }
  | { type: 'agent_not_found'; agent_name: string }
  | { type: 'turn_failed'; failure: TurnExecutorFailure };

export type IntegrationResumeResult =
  | { type: 'resumed'; turn_id: string; session_id: string; summary: string }
  /** Another click, a channel retry, or a text answer already settled this turn. */
  | { type: 'already_settled' }
  /** The turn is not waiting on this decision any more, or never was. */
  | { type: 'not_pending'; reason: string }
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

/** The conversation's tip turn, if it has one. Read from the session row, so it costs one turn read. */
async function tipTurn(session: SessionHandle) {
  const tip = session.record.last_turn_id;
  return tip === null ? undefined : session.getTurn(tip);
}

/** Provenance only; it never changes what the turn is allowed to do. */
function senderMetadata(sender: InboundSender): Record<string, string> {
  return {
    'integration.sender_id': sender.id.slice(0, METADATA_VALUE_MAX_LENGTH),
    'integration.sender_name': sender.display_name.slice(0, METADATA_VALUE_MAX_LENGTH),
  };
}

/** A denial names who denied it, because that is the only record the agent ever sees. */
function denialReason(sender: InboundSender): string {
  return `Denied by ${sender.display_name} (${sender.id}) from the channel.`;
}

/** The line that replaces the buttons, so the thread shows who decided and what. */
function decisionSummary(input: { interaction: InboundInteraction }): string {
  const { sender, decision } = input.interaction;
  if (decision.type === 'approval') {
    return `${decision.approved ? 'Approved' : 'Denied'} by <@${sender.id}>.`;
  }
  return `<@${sender.id}> answered: ${decision.text}`;
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
    const { integrationStore, sessions, agentStore, logger } = this.#deps;

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

    // Nothing ran for this event yet, so its dedupe rows must not outlive a failure: keeping
    // them would make the channel's retry look like a replay and the message would be lost.
    const claimedRowIds = [eventRowId];
    const release = async (): Promise<void> => {
      for (const id of claimedRowIds) {
        await integrationStore.deleteEvent({ id });
      }
    };

    const agentName = integration.manifest.default_agent_name;
    const agent = await agentStore.getAgent({ tenant_id: integration.tenant_id, name: agentName });
    if (agent === undefined) {
      await release();
      return { type: 'agent_not_found', agent_name: agentName };
    }

    const sessionExternalId = await toSessionExternalId(event.conversation_key);
    const { session } = await sessions.getOrCreateByExternalId({
      tenant_id: integration.tenant_id,
      external_id: sessionExternalId,
      created_by_subject: integration.created_by_subject,
      agent: { type: 'reference', id: agent.id, name: agent.name },
      source: { type: 'integration', id: integration.id, conversation_key: event.conversation_key },
      metadata: senderMetadata(event.sender),
    });

    const tip = await tipTurn(session);
    // A second turn would take the session tip from the first and cancel it, so a busy
    // conversation is told to wait instead. The event stays deduped: the notice is the answer.
    if (tip?.state.status === 'running') {
      this.#notice({ integration, adapter, event, session_id: session.session_id });
      return { type: 'busy', running_turn_id: tip.id };
    }

    // A thread waiting on a question is answered by a plain reply, which is the only way to
    // answer in free text. A thread waiting on an approval is not: a decision needs the buttons,
    // and sending a user message into a thread that is holding tool calls is refused anyway.
    const pending = tip === undefined ? undefined : await this.#pendingAction(tip);
    if (pending?.type === 'approval' && tip !== undefined) {
      this.#notice({ integration, adapter, event, session_id: session.session_id, text: APPROVAL_PENDING_NOTICE });
      return { type: 'busy', running_turn_id: tip.id };
    }
    const question = pending?.type === 'question' ? pending.question : undefined;
    let turnInput: TurnInputItem[] = [{ type: 'user.message', content: event.text }];
    if (question !== undefined && tip !== undefined) {
      // A button click and this reply are two ways to settle one held turn, so they take the
      // same row. Losing it means the question is already answered and a resume is under way.
      const resumeRowId = newId();
      const claimed = await integrationStore.recordEvent({
        id: resumeRowId,
        tenant_id: integration.tenant_id,
        integration_id: integration.id,
        event_id: resumeEventId(tip.id),
      });
      if (!claimed.recorded) {
        this.#notice({ integration, adapter, event, session_id: session.session_id });
        return { type: 'busy', running_turn_id: tip.id };
      }
      claimedRowIds.push(resumeRowId);
      turnInput = [
        {
          type: EventType.USER_TOOL_RESPONSE,
          thread_id: question.thread_id,
          tool_call_id: question.tool_call_id,
          content: event.text,
        },
      ];
    }

    const started = await this.#startTurn({
      integration,
      agent,
      session,
      session_external_id: sessionExternalId,
      conversation_key: event.conversation_key,
      input: turnInput,
    });
    if (!started.ok) {
      await release();
      logger.warn('Integration turn could not start', {
        integrationId: integration.id,
        sessionId: session.session_id,
        code: started.failure.code,
        message: started.failure.message,
      });
      return { type: 'turn_failed', failure: started.failure };
    }
    return { type: 'started', turn_id: started.turn_id, session_id: session.session_id };
  }

  /**
   * Turns a verified button click into the approval or tool response that resumes its turn.
   *
   * The click names the turn, but nothing else about it is trusted: the turn has to be this
   * conversation's tip, finished, and still holding the tool call the button names. One guarded
   * write per turn is what makes a double click, a channel retry and a racing text answer all
   * land as one resume.
   */
  async resume(input: {
    integration: IntegrationRecord;
    interaction: InboundInteraction;
  }): Promise<IntegrationResumeResult> {
    const { integration, interaction } = input;
    const { integrationStore, sessions, agentStore, logger } = this.#deps;

    const eventRowId = newId();
    const { recorded } = await integrationStore.recordEvent({
      id: eventRowId,
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      event_id: resumeEventId(interaction.turn_id),
    });
    if (!recorded) {
      return { type: 'already_settled' };
    }
    const release = async (): Promise<void> => {
      await integrationStore.deleteEvent({ id: eventRowId });
    };

    const sessionExternalId = await toSessionExternalId(interaction.conversation_key);
    const session = await sessions.getByExternalId({
      tenant_id: integration.tenant_id,
      external_id: sessionExternalId,
    });
    if (session === undefined) {
      await release();
      return { type: 'not_pending', reason: 'That conversation no longer has a session' };
    }

    const stale = {
      type: 'not_pending',
      reason: 'That decision is no longer the one this thread is waiting on',
    } as const;
    const tip = await tipTurn(session);
    // Resuming anything but the tip would fork the session and leave the real tip hanging.
    if (tip === undefined) {
      await release();
      return stale;
    }
    if (tip.id !== interaction.turn_id || tip.state.status === 'running') {
      await release();
      return stale;
    }
    const pending = await readPendingAction({ turn: tip, state: tip.state });
    const turnInput = resumeInput({ interaction, pending });
    if (turnInput === undefined) {
      await release();
      return stale;
    }

    const agentName = integration.manifest.default_agent_name;
    const agent = await agentStore.getAgent({ tenant_id: integration.tenant_id, name: agentName });
    if (agent === undefined) {
      await release();
      return { type: 'agent_not_found', agent_name: agentName };
    }

    const started = await this.#startTurn({
      integration,
      agent,
      session,
      session_external_id: sessionExternalId,
      conversation_key: interaction.conversation_key,
      input: [turnInput],
    });
    if (!started.ok) {
      await release();
      logger.warn('Integration turn could not resume', {
        integrationId: integration.id,
        sessionId: session.session_id,
        code: started.failure.code,
        message: started.failure.message,
      });
      return { type: 'turn_failed', failure: started.failure };
    }
    return {
      type: 'resumed',
      turn_id: started.turn_id,
      session_id: session.session_id,
      summary: decisionSummary({ interaction }),
    };
  }

  /** What a finished tip is waiting on, if anything. Costs nothing for a tip holding nothing. */
  async #pendingAction(tip: NonNullable<Awaited<ReturnType<typeof tipTurn>>>): Promise<PendingAction | undefined> {
    return tip.state.status === 'running' ? undefined : readPendingAction({ turn: tip, state: tip.state });
  }

  #notice(input: {
    integration: IntegrationRecord;
    adapter: ChannelAdapter;
    event: InboundEvent;
    session_id: string;
    text?: string;
  }): void {
    const { integration, adapter, event } = input;
    this.#deps.deferDelivery(async () => {
      const posted = await adapter.notice({
        manifest: integration.manifest,
        conversation_key: event.conversation_key,
        text: input.text ?? BUSY_CONVERSATION_NOTICE,
      });
      if (!posted.ok) {
        this.#deps.logger.warn('Integration busy notice was not posted', {
          integrationId: integration.id,
          sessionId: input.session_id,
          reason: posted.error,
        });
      }
    });
  }

  /**
   * Starts the turn and records the reply it owes. `'auto'` continues from the session tip, so
   * the first message opens a thread, later messages continue it, and a resume chains onto the
   * turn it answers.
   */
  async #startTurn(input: {
    integration: IntegrationRecord;
    agent: AgentRecord;
    session: SessionHandle;
    session_external_id: string;
    conversation_key: string;
    input: TurnInputItem[];
  }): Promise<{ ok: true; turn_id: string } | { ok: false; failure: TurnExecutorFailure }> {
    const { integration, session } = input;
    const { integrationStore, turnExecutor, resolveTurnStores, notifier, logger } = this.#deps;

    const started = await turnExecutor.start({
      session,
      input: input.input,
      previous_turn_id: 'auto',
      userRef: integration.created_by_subject.subject_id,
      stores: resolveTurnStores(input.agent),
    });
    if (!started.ok) {
      return { ok: false, failure: started };
    }

    const { enqueued } = await integrationStore.enqueueDelivery({
      id: newId(),
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      conversation_key: input.conversation_key,
      turn_id: started.turn.id,
      session_external_id: input.session_external_id,
      next_attempt_at: firstAttemptDueAt(),
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
    return { ok: true, turn_id: started.turn.id };
  }
}

/**
 * One dedupe key per held turn, whatever settles it. Two clicks, a channel retry of one click,
 * and a text answer racing a button all collapse onto this row, and only the writer that lands
 * it resumes the turn — which matters because a second resume would fork the session.
 */
export function resumeEventId(turnId: string): string {
  return `resume:${turnId}`;
}

/** The turn input a decision becomes, or undefined when the turn is not holding that call. */
function resumeInput(input: {
  interaction: InboundInteraction;
  pending: Awaited<ReturnType<typeof readPendingAction>>;
}): TurnInputItem | undefined {
  const { interaction, pending } = input;
  const { decision } = interaction;
  if (decision.type === 'approval') {
    if (pending?.type !== 'approval') {
      return undefined;
    }
    const held = pending.approvals.find(approval => approval.tool_call_id === interaction.tool_call_id);
    if (held === undefined) {
      return undefined;
    }
    return {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: held.thread_id,
      tool_call_id: held.tool_call_id,
      approval: decision.approved ? { status: 'allow' } : { status: 'deny', reason: denialReason(interaction.sender) },
    };
  }
  if (pending?.type !== 'question' || pending.question.tool_call_id !== interaction.tool_call_id) {
    return undefined;
  }
  return {
    type: EventType.USER_TOOL_RESPONSE,
    thread_id: pending.question.thread_id,
    tool_call_id: pending.question.tool_call_id,
    content: decision.text,
  };
}
