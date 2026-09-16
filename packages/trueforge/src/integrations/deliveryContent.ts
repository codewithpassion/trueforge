import type { TerminalTurnState } from '@truefoundry/trueforge-core/agent-session';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
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
 * What the channel posts for a finished turn: the final assistant message, or a short
 * status line when the turn produced no answer.
 */
export function buildDeliveryContent(state: TerminalTurnState): DeliveryContent {
  switch (state.status) {
    case 'done': {
      const text = state.output === null ? '' : assistantText(state.output.content);
      if (text.length > 0) {
        return { type: 'message', text };
      }
      return {
        type: 'status',
        state: 'done',
        detail:
          state.required_actions.length > 0
            ? 'The agent is waiting for input it cannot ask for here.'
            : 'The agent finished without a reply.',
      };
    }
    case 'cancelled':
      return { type: 'status', state: 'cancelled', detail: `The run was cancelled (${state.reason}).` };
    case 'error':
      // The provider's message can carry urls and account ids, so it stays in the logs.
      return { type: 'status', state: 'error', detail: 'The agent could not finish this run.' };
  }
}
