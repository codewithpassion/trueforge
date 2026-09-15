import { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import { DurableObject } from 'cloudflare:workers';
import { requestContextFromCreatedBySubject } from '../auth/identity';
import configuration from '../config';
import { dispatchScheduledRuns, SCHEDULE_DISPATCH_INTERVAL_MS } from '../controller/scheduleDispatch';
import { executeScheduleRun } from '../controller/scheduleRunExecution';
import type { ScheduleDispatchItem } from '../db/scheduleStore';
import { createConsoleLogger } from './logger';
import { createWorkersRuntimeDeps, type WorkersRuntimeDeps } from './runtime';

/** The one scheduler instance: `idFromName(SCHEDULER_INSTANCE_NAME)`. */
export const SCHEDULER_INSTANCE_NAME = 'singleton';

/** Alarm handlers get 15 minutes of wall time; a pass stops starting runs before that. */
const DISPATCH_PASS_BUDGET_MS = 14 * 60_000;

/**
 * Schedule dispatch on Workers. Dispatch requires exactly one controller per database; a single named
 * instance holds that, because a Durable Object runs its alarms one at a time.
 */
export class SchedulerDO extends DurableObject {
  readonly #logger = createConsoleLogger({ level: configuration.LOG_LEVEL, bindings: { component: 'SchedulerDO' } });
  #deps: WorkersRuntimeDeps | undefined;

  /** Arms dispatch when no alarm is pending; an armed alarm keeps its time. */
  async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  override async alarm(): Promise<void> {
    const abort = new AbortController();
    const budget = setTimeout(() => {
      abort.abort();
    }, DISPATCH_PASS_BUDGET_MS);
    try {
      const result = await dispatchScheduledRuns({
        store: this.#runtimeDeps().persistence.scheduleStore,
        withTransaction: this.#runtimeDeps().persistence.withTransaction,
        onTriggered: item => this.#startRun(item),
        logger: this.#logger,
        signal: abort.signal,
      });
      if (result.dispatched > 0 || result.failed > 0) {
        this.#logger.debug('Scheduled runs dispatched or failed', result);
      }
    } catch (error) {
      // Per-run failures are handled inside the pass; this is a pass that could not run at all.
      this.#logger.error('Schedule dispatch pass failed', extractErrorLogFields(error));
    } finally {
      clearTimeout(budget);
      await this.ctx.storage.setAlarm(Date.now() + SCHEDULE_DISPATCH_INTERVAL_MS);
    }
  }

  /** Throws when the turn cannot start, so dispatch records the run as failed. */
  async #startRun(item: ScheduleDispatchItem): Promise<void> {
    const { persistence, turnExecutor } = this.#runtimeDeps();
    const requestContext = requestContextFromCreatedBySubject({
      tenant_id: item.schedule.tenant_id,
      created_by_subject: item.schedule.created_by_subject,
    });
    const failure = await executeScheduleRun({
      item,
      deps: {
        sessions: new Sessions({ sessionStore: persistence.sessionStore }),
        agentStore: persistence.agentStore,
        turnExecutor,
        resolveTurnStores: agent => ({
          agentStore: persistence.agentStore,
          modelProviderStore: persistence.resolveModelProviderStore(requestContext, agent),
          mcpServerStore: persistence.resolveMcpServerStore(requestContext, agent),
          sandboxProviderStore: persistence.resolveSandboxProviderStore(requestContext),
          skillStore: persistence.turnSkillsResolverStore,
        }),
      },
    });
    if (failure !== undefined) {
      throw new Error(failure.message);
    }
  }

  #runtimeDeps(): WorkersRuntimeDeps {
    this.#deps ??= createWorkersRuntimeDeps(this.env);
    return this.#deps;
  }
}
