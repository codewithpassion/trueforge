import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { ControlLoop } from '../controller/Controller';
import type { IComputerStore } from '../db/computerStore';

/** How long a record of what ran on someone's machine is kept. */
export const COMPUTER_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The log grows with real work, not with traffic, so one sweep an hour is plenty. */
export const COMPUTER_AUDIT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const COMPUTER_AUDIT_PRUNE_LOOP_NAME = 'computer-audit-prune';

/** Drops activity past the retention window. Never throws; a failed sweep retries next pass. */
export async function pruneComputerAudit<TTransaction>(input: {
  computerStore: IComputerStore<TTransaction>;
  logger: Logger;
}): Promise<void> {
  try {
    const removed = await input.computerStore.deleteAuditBefore({
      before: new Date(Date.now() - COMPUTER_AUDIT_RETENTION_MS).toISOString(),
    });
    if (removed > 0) {
      input.logger.debug('Pruned remote computer activity', { removed });
    }
  } catch (error) {
    input.logger.warn('Could not prune remote computer activity', extractErrorLogFields(error));
  }
}

export function computerAuditPruneLoop<TTransaction>(params: {
  computerStore: IComputerStore<TTransaction>;
  logger: Logger;
}): ControlLoop {
  return {
    name: COMPUTER_AUDIT_PRUNE_LOOP_NAME,
    intervalMs: COMPUTER_AUDIT_PRUNE_INTERVAL_MS,
    tick: () => pruneComputerAudit(params),
  };
}
