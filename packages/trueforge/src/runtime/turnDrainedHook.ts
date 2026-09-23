import type { SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ComputersService } from '../computers/service';
import type { TurnDesktopLeases } from '../computers/turnDesktopLeases';
import type { IAgentStore } from '../db/agentStore';
import { readPendingAction } from '../integrations/pendingActions';
import type { TurnDrainedHook } from './turnRunner';

/**
 * Lets go of the desktop on every computer the turn sent a desktop op to, however the turn ended.
 * A turn that never touched a desktop costs no relay call.
 */
export async function releaseComputerLeases({
  computers,
  desktopLeases,
  session,
  turn_id,
}: {
  computers: Pick<ComputersService, 'relay'>;
  desktopLeases: TurnDesktopLeases;
  session: Pick<SessionHandle, 'tenant_id' | 'session_id'>;
  turn_id: string;
}): Promise<void> {
  for (const computerId of desktopLeases.take(turn_id)) {
    await computers.relay(computerId).releaseLease({
      tenant_id: session.tenant_id,
      session_id: session.session_id,
      turn_id,
    });
  }
}

/**
 * Tells the agent's computer that this session waits for a person, when the turn finished asking
 * for a takeover. Cancelled and failed turns asked nothing anyone can answer, so they record none.
 * The computer is the agent's current one: the turn may have asked before touching the desktop.
 */
export async function recordTakeoverPointer({
  computers,
  agentStore,
  session,
  turn_id,
}: {
  computers: Pick<ComputersService, 'relay'>;
  agentStore: Pick<IAgentStore, 'getAgent'>;
  session: Pick<SessionHandle, 'tenant_id' | 'session_id' | 'agent' | 'getTurn'>;
  turn_id: string;
}): Promise<void> {
  // Inline agents cannot use a computer, so they never offer the tool.
  if (session.agent.type !== 'reference') {
    return;
  }
  const turn = await session.getTurn(turn_id);
  const state = turn?.state;
  if (turn === undefined || state?.status !== 'done' || state.required_actions.length === 0) {
    return;
  }
  const pending = await readPendingAction({ turn, state });
  if (pending?.type !== 'takeover') {
    return;
  }
  const agent = await agentStore.getAgent({ tenant_id: session.tenant_id, id: session.agent.id });
  const computerId = agent?.manifest.config.sandbox.computer_id;
  if (computerId === undefined) {
    return;
  }
  await computers.relay(computerId).recordTakeoverPointer({
    tenant_id: session.tenant_id,
    session_id: session.session_id,
    turn_id,
  });
}

/**
 * Everything that runs when a turn drains: result delivery, then the desktop leases, then a
 * pending takeover. Each step is isolated, so a delivery that fails still releases the leases.
 */
export function createTurnDrainedHook({
  deliver,
  desktop,
  logger,
}: {
  deliver: TurnDrainedHook;
  /** Undefined on a runtime without remote computers, where no lease can be held. */
  desktop:
    | {
        computers: Pick<ComputersService, 'relay'>;
        leases: TurnDesktopLeases;
        /** Finds the computer a takeover request belongs to. */
        agentStore: Pick<IAgentStore, 'getAgent'>;
      }
    | undefined;
  logger: Logger;
}): TurnDrainedHook {
  const steps: { name: string; run: TurnDrainedHook }[] = [{ name: 'deliver', run: deliver }];
  if (desktop !== undefined) {
    steps.push({
      name: 'release_computer_leases',
      run: input => releaseComputerLeases({ computers: desktop.computers, desktopLeases: desktop.leases, ...input }),
    });
    steps.push({
      name: 'record_takeover_pointer',
      run: input => recordTakeoverPointer({ computers: desktop.computers, agentStore: desktop.agentStore, ...input }),
    });
  }
  return async input => {
    for (const step of steps) {
      try {
        await step.run(input);
      } catch (error) {
        logger.error('Turn drained step failed', {
          step: step.name,
          sessionId: input.session.session_id,
          turnId: input.turn_id,
          ...extractErrorLogFields(error),
        });
      }
    }
  };
}
