import type { TerminalTurnState, TurnHandle } from '@truefoundry/trueforge-core/agent-session';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
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
 * What the channel posts for a finished turn: the final assistant message, the decision the
 * turn is held on, or a short status line when it produced neither.
 *
 * The extra read that resolves a pending action only happens for a turn that actually paused.
 */
export async function buildDeliveryContent(input: {
  turn: Pick<TurnHandle, 'listEvents'>;
  turn_id: string;
  state: TerminalTurnState;
}): Promise<DeliveryContent> {
  const { state } = input;
  switch (state.status) {
    case 'done': {
      const text = state.output === null ? '' : assistantText(state.output.content);
      // A held turn is checked before its text, because the model often narrates the call it is
      // about to make; posting only that narration would leave the turn waiting forever.
      if (state.required_actions.length > 0) {
        const pending = await readPendingAction({ turn: input.turn, state });
        if (pending?.type === 'approval') {
          return { type: 'approval_request', turn_id: input.turn_id, intro: text, approvals: pending.approvals };
        }
        if (pending?.type === 'question') {
          return { type: 'question', turn_id: input.turn_id, intro: text, question: pending.question };
        }
        if (text.length === 0) {
          return { type: 'status', state: 'done', detail: 'The agent is waiting for input it cannot ask for here.' };
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
