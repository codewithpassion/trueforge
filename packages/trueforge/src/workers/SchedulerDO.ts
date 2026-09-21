import { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import { DurableObject } from 'cloudflare:workers';
import { requestContextFromCreatedBySubject } from '../auth/identity';
import configuration from '../config';
import { dispatchScheduledRuns, SCHEDULE_DISPATCH_INTERVAL_MS } from '../controller/scheduleDispatch';
import { executeScheduleRun } from '../controller/scheduleRunExecution';
import type { ScheduleDispatchItem } from '../db/scheduleStore';
import { INTEGRATION_EVENT_PRUNE_INTERVAL_MS, pruneIntegrationEvents } from '../integrations/pruneEvents';
import { createIntegrationAdapters } from '../integrations/registry';
import { DELIVERY_RETRY_INTERVAL_MS, retryIntegrationDeliveries } from '../integrations/retryDeliveries';
import { TurnCompletionNotifier } from '../integrations/TurnCompletionNotifier';
import { ALARM_PASS_BUDGET_MS } from './alarmBudget';
import { createConsoleLogger } from './logger';
import { createWorkersRuntimeDeps, type WorkersRuntimeDeps } from './runtime';

/** The one scheduler instance: `idFromName(SCHEDULER_INSTANCE_NAME)`. */
export const SCHEDULER_INSTANCE_NAME = 'singleton';

/** Durable Object storage keys holding the last sweep times, in epoch ms. */
const LAST_INTEGRATION_PRUNE_KEY = 'last_integration_prune_at';
const LAST_DELIVERY_RETRY_KEY = 'last_delivery_retry_at';

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
    }, ALARM_PASS_BUDGET_MS);
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
      await this.#pruneIntegrationEventsIfDue(abort.signal);
      await this.#retryDeliveriesIfDue(abort.signal);
    } catch (error) {
      // Per-run failures are handled inside the pass; this is a pass that could not run at all.
      this.#logger.error('Schedule dispatch pass failed', extractErrorLogFields(error));
    } finally {
      clearTimeout(budget);
      await this.ctx.storage.setAlarm(Date.now() + SCHEDULE_DISPATCH_INTERVAL_MS);
    }
  }

  /**
   * The singleton is the one place a database-wide sweep can run without overlapping itself, but
   * dispatch wakes every minute, so each sweep's last run time is kept in storage to pace it.
   *
   * The time is stamped after the pass, not before: an alarm killed at the wall clock never
   * stamps, so the next one picks the work up instead of waiting out the interval. Sweeps do not
   * throw, so this cannot spin.
   */
  async #sweepIfDue(input: {
    key: string;
    intervalMs: number;
    run: () => Promise<void>;
    signal: AbortSignal;
  }): Promise<void> {
    const now = Date.now();
    const last = await this.ctx.storage.get<number>(input.key);
    // Read through a call, not a field: the pass can run out of time while `run` is awaited,
    // and a narrowed `aborted` would still read as it did before.
    const outOfTime = (): boolean => input.signal.aborted;
    if ((last !== undefined && now - last < input.intervalMs) || outOfTime()) {
      return;
    }
    await input.run();
    if (!outOfTime()) {
      await this.ctx.storage.put(input.key, Date.now());
    }
  }

  async #pruneIntegrationEventsIfDue(signal: AbortSignal): Promise<void> {
    await this.#sweepIfDue({
      key: LAST_INTEGRATION_PRUNE_KEY,
      intervalMs: INTEGRATION_EVENT_PRUNE_INTERVAL_MS,
      signal,
      run: () =>
        pruneIntegrationEvents({
          integrationStore: this.#runtimeDeps().persistence.integrationStore,
          logger: this.#logger,
        }),
    });
  }

  async #retryDeliveriesIfDue(signal: AbortSignal): Promise<void> {
    const { persistence } = this.#runtimeDeps();
    await this.#sweepIfDue({
      key: LAST_DELIVERY_RETRY_KEY,
      intervalMs: DELIVERY_RETRY_INTERVAL_MS,
      signal,
      run: () =>
        retryIntegrationDeliveries({
          integrationStore: persistence.integrationStore,
          sessions: new Sessions({ sessionStore: persistence.sessionStore }),
          notifier: new TurnCompletionNotifier({
            integrationStore: persistence.integrationStore,
            scheduleStore: persistence.scheduleStore,
            adapters: createIntegrationAdapters(),
            logger: this.#logger,
          }),
          logger: this.#logger,
          signal,
        }),
    });
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
        // Required by the executor contract; the session Durable Object resolves its own D1 stores and ignores these.
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
