import type { SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ComputersService } from '../computers/service';
import type { TurnDesktopLeases } from '../computers/turnDesktopLeases';
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
 * Everything that runs when a turn drains: result delivery, then the desktop leases. Each step is
 * isolated, so a delivery that fails still releases the leases.
 */
export function createTurnDrainedHook({
  deliver,
  desktop,
  logger,
}: {
  deliver: TurnDrainedHook;
  /** Undefined on a runtime without remote computers, where no lease can be held. */
  desktop: { computers: Pick<ComputersService, 'relay'>; leases: TurnDesktopLeases } | undefined;
  logger: Logger;
}): TurnDrainedHook {
  const steps: { name: string; run: TurnDrainedHook }[] = [{ name: 'deliver', run: deliver }];
  if (desktop !== undefined) {
    steps.push({
      name: 'release_computer_leases',
      run: input => releaseComputerLeases({ computers: desktop.computers, desktopLeases: desktop.leases, ...input }),
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
