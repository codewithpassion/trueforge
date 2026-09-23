import type { SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { computerIdFromSandboxRef } from '../computers/RemoteComputerProvider';
import type { ComputersService } from '../computers/service';
import type { TurnDrainedHook } from './turnRunner';

/**
 * Lets go of the desktop when a turn ends, however it ended. The computer comes from the sandbox the
 * turn recorded, which carries over from earlier turns, so a session that never used a computer
 * costs one turn read and no relay call.
 */
export async function releaseComputerLease({
  computers,
  session,
  turn_id,
}: {
  computers: Pick<ComputersService, 'relay'>;
  session: Pick<SessionHandle, 'session_id' | 'getTurn'>;
  turn_id: string;
}): Promise<void> {
  const turn = await session.getTurn(turn_id);
  const sandboxId = turn?.record.snapshot.sandbox_info?.sandbox_id;
  const computerId = sandboxId === undefined ? undefined : computerIdFromSandboxRef(sandboxId);
  if (computerId === undefined) {
    return;
  }
  await computers.relay(computerId).releaseLease({ session_id: session.session_id });
}

/**
 * Everything that runs when a turn drains: result delivery, then the desktop lease. Each step is
 * isolated, so a delivery that fails still releases the lease.
 */
export function createTurnDrainedHook({
  deliver,
  computers,
  logger,
}: {
  deliver: TurnDrainedHook;
  /** Undefined on a runtime without remote computers, where no lease can be held. */
  computers: Pick<ComputersService, 'relay'> | undefined;
  logger: Logger;
}): TurnDrainedHook {
  const steps: { name: string; run: TurnDrainedHook }[] = [{ name: 'deliver', run: deliver }];
  if (computers !== undefined) {
    steps.push({ name: 'release_computer_lease', run: input => releaseComputerLease({ computers, ...input }) });
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
