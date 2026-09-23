import type { SessionHandle, TerminalTurnState, TurnHandle } from '@truefoundry/trueforge-core/agent-session';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { agentScreenUrl } from '../computers/requestHumanTakeover';
import { getPublicBaseUrlOrUndefined } from '../config';
import { readPendingAction } from './pendingActions';
import type { DeliveryContent } from './types';

/** Assistant content is a plain string or OpenAI content parts; refusals read as text. */
function assistantText(content: ModelMessageEvent['content']): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (content == null) {
    return '';
  }
  return content
    .map(part => (part.type === 'text' ? part.text : part.refusal))
    .join('')
    .trim();
}

/**
 * Whether a click on the message being built could reach the turn it is about. True only when
 * the message goes back to the conversation the turn's own session is keyed by: a notification
 * rule posts to a channel the session was never bound to, so a button there could never resume
 * anything. Both the drain hook and the retry sweep answer it the same way, from this one
 * comparison, so they cannot drift.
 */
export function deliveryIsInteractive(input: { conversation_key: string; session_external_id: string }): boolean {
  return input.conversation_key === input.session_external_id;
}

/**
 * What the channel posts for a finished turn: the final assistant message, the decision the
 * turn is held on, or a short status line when it produced neither. A takeover request needs no
 * buttons, so it is posted whether or not the channel can resume the turn.
 *
 * The extra read that resolves a pending action only happens for a turn that actually paused.
 */
export async function buildDeliveryContent(input: {
  turn: Pick<TurnHandle, 'listEvents'>;
  turn_id: string;
  state: TerminalTurnState;
  /** The session's agent, whose Screen page a takeover request links to. */
  agent: SessionHandle['agent'];
  /** False posts a status line where buttons would go, because nothing could click them. */
  interactive: boolean;
}): Promise<DeliveryContent> {
  const { state } = input;
  switch (state.status) {
    case 'done': {
      const text = state.output === null ? '' : assistantText(state.output.content);
      // A held turn is checked before its text, because the model often narrates the call it is
      // about to make; posting only that narration would leave the turn waiting forever.
      if (state.required_actions.length > 0) {
        const pending = await readPendingAction({ turn: input.turn, state });
        if (pending?.type === 'takeover' && input.agent.type === 'reference') {
          return {
            type: 'takeover_request',
            turn_id: input.turn_id,
            intro: text,
            takeover: pending.takeover,
            screen_url: agentScreenUrl({ public_base_url: getPublicBaseUrlOrUndefined(), agent_id: input.agent.id }),
          };
        }
        if (input.interactive && pending?.type === 'approval') {
          return { type: 'approval_request', turn_id: input.turn_id, intro: text, approvals: pending.approvals };
        }
        if (input.interactive && pending?.type === 'question') {
          return { type: 'question', turn_id: input.turn_id, intro: text, question: pending.question };
        }
        if (text.length === 0) {
          return {
            type: 'status',
            state: 'done',
            detail: input.interactive
              ? 'The agent is waiting for input it cannot ask for here.'
              : 'The run is waiting for a decision, which can only be taken in TrueForge.',
          };
        }
      }
      if (text.length > 0) {
        return { type: 'message', text };
      }
      return { type: 'status', state: 'done', detail: 'The agent finished without a reply.' };
    }
    case 'cancelled':
      return { type: 'status', state: 'cancelled', detail: `The run was cancelled (${state.reason}).` };
    case 'error':
      // The provider's message can carry urls and account ids, so it stays in the logs.
      return { type: 'status', state: 'error', detail: 'The agent could not finish this run.' };
  }
}
