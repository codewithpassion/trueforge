import type { TurnHandle } from '@truefoundry/trueforge-core/agent-session';
import type { PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session/schemas/events';

/**
 * The slice of a turn that `readPendingAction` uses: one page of persisted events, newest
 * first. Given in chronological order and reversed here, so a case reads the way a turn ran.
 */
export function turnEventReader(events: readonly PersistedTurnEvent[]): Pick<TurnHandle, 'listEvents'> {
  return {
    listEvents: input =>
      Promise.resolve({
        data: [...events].reverse().slice(0, input.limit),
        pagination: { limit: input.limit },
      }),
  };
}
