import type { Sessions } from '@truefoundry/trueforge-core/agent-session';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { ScheduleDispatchItem } from '../db/scheduleStore';
import type { TurnExecutor, TurnExecutorFailure, TurnStores } from '../runtime/turnExecutor';
import { startScheduleRun } from './scheduleDispatch';

export interface ScheduleRunExecutionDeps {
  sessions: Sessions;
  /** Schedule agent binding is not caller-scoped. */
  agentStore: IAgentStore;
  turnExecutor: TurnExecutor;
  /** Stores bound to the schedule creator for the run's agent. */
  resolveTurnStores: (agent: AgentRecord) => TurnStores;
}

/**
 * Starts a schedule run's turn in the session keyed by the run id, without an HTTP hop. A session that
 * already has a turn is left alone, so a re-dispatched run does not start a second turn. Returns the
 * executor's failure when the turn could not start.
 */
export async function executeScheduleRun({
  item,
  deps,
}: {
  item: ScheduleDispatchItem;
  deps: ScheduleRunExecutionDeps;
}): Promise<TurnExecutorFailure | undefined> {
  const prepared = await startScheduleRun({ item, sessions: deps.sessions, agentStore: deps.agentStore });
  if (prepared === undefined) {
    return undefined;
  }
  const started = await deps.turnExecutor.start({
    session: prepared.session,
    input: prepared.input,
    previous_turn_id: prepared.previous_turn_id,
    userRef: prepared.userRef,
    stores: deps.resolveTurnStores(prepared.agent),
  });
  return started.ok ? undefined : started;
}
