import {
  CancellationReason,
  Sessions,
  type TurnInputItem,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import { DurableObject } from 'cloudflare:workers';
import { TurnDesktopLeases } from '../computers/turnDesktopLeases';
import configuration from '../config';
import { D1ValueTooLargeError, D1WriteOutcomeUnknownError } from '../db/d1/client';
import { createD1Persistence } from '../db/d1/persistence';
import { createIntegrationAdapters } from '../integrations/registry';
import { TurnCompletionNotifier } from '../integrations/TurnCompletionNotifier';
import { ActiveTurnRegistry } from '../runtime/activeTurns';
import { StreamGoneError } from '../runtime/event-subscription';
import { createTurnDrainedHook } from '../runtime/turnDrainedHook';
import {
  freezeTurnIgnoringMissing,
  turnStartFailure,
  type TurnExecutorFailure,
  type TurnStartResult,
} from '../runtime/turnExecutor';
import { startTurnInProcess, toWireTurn, turnStreamId } from '../runtime/turnRunner';
import type { SandboxIntegration } from '../sandbox/integration';
import { newId } from '../utils/id';
import { ALARM_PASS_BUDGET_MS } from './alarmBudget';
import { workersComputersService } from './computersService';
import { DurableObjectEventSubscriptions } from './durableObjectEventSubscriptions';
import type { Env } from './env';
import { WORKERS_EXECUTOR_ID } from './executorId';
import { INSTANCE_LIVENESS_PROBE_MS, probeInstanceAlive } from './instanceLiveness';
import { createConsoleLogger } from './logger';
import { CodeModeBridgeRegistry, type CodeModeDispatchOutcome } from './sandbox/codeModeBridge';
import { workersSandboxIntegrationFromEnv } from './sandbox/workersSandboxIntegration';
import { encodeTurnEvents, isSequencedTurnStreamingEvent } from './turnEventWire';
import { turnInputTooLarge } from './turnInputLimit';

/** The watchdog runs again this long after a pass that left orphans or was lost mid-turn. */
const WATCHDOG_DELAY_MS = 60_000;
/** D1 allows 1000 queries per invocation; a turn past this many statements is close to failing. */
export const D1_TURN_STATEMENT_WARNING = 800;
/** The watchdog stops retrying an orphan once this long has passed since its first failure. */
const WATCHDOG_RETRY_WINDOW_MS = 60 * 60 * 1000;

interface StartedTurnRow extends Record<string, SqlStorageValue> {
  turn_id: string;
  tenant_id: string;
  session_id: string;
  attempts: number;
  first_failed_at: number | null;
}

/** `CREATE TABLE IF NOT EXISTS` keeps an existing object's older table, so later columns are added here. */
function createStartedTurnsSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS started_turns (
      turn_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_failed_at INTEGER
    )`,
  );
  const columns = new Set(
    sql
      .exec<{ name: string }>('PRAGMA table_info(started_turns)')
      .toArray()
      .map(column => column.name),
  );
  if (!columns.has('attempts')) {
    sql.exec('ALTER TABLE started_turns ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('first_failed_at')) {
    sql.exec('ALTER TABLE started_turns ADD COLUMN first_failed_at INTEGER');
  }
}

export interface StartTurnRequest {
  tenant_id: string;
  session_id: string;
  input: TurnInputItem[] | undefined;
  previous_turn_id: string | undefined;
  user_ref: string;
}

export type TurnEventStreamResult = { ok: true; stream: ReadableStream<Uint8Array> } | TurnExecutorFailure;

/** A turn this instance executes. The session id is kept so a lost instance can still abort it. */
interface RunningTurn {
  readonly session_id: string;
  readonly settled: Promise<undefined>;
}

/** Why an alarm stopped holding its turns. `lost` means the object moved to another instance. */
type HoldOutcome = 'settled' | 'budget' | 'lost';

function startFailure(error: unknown): TurnExecutorFailure | undefined {
  if (error instanceof D1WriteOutcomeUnknownError) {
    // The write may have committed; a retry could fork the session a second time.
    return { ok: false, status: 503, code: 'write_outcome_unknown', message: error.message };
  }
  if (error instanceof D1ValueTooLargeError) {
    return { ok: false, status: 413, code: 'value_too_large', message: error.message };
  }
  return turnStartFailure(error);
}

/**
 * One session's turn runner (`idFromName("<tenant_id>:<session_id>")`): executes turns, keeps their
 * resumable event logs in SQLite storage, serves subscriptions, and freezes turns orphaned by eviction.
 */
export class SessionDO extends DurableObject {
  readonly #activeTurns = new ActiveTurnRegistry();
  readonly #events: DurableObjectEventSubscriptions<TurnStreamingEvent>;
  /** Turns this instance runs, from start request to drain end; `settled` resolves when the drain settles. */
  readonly #running = new Map<string, RunningTurn>();
  /** Distinguishes two instances of one object in the logs, which the platform never names. */
  readonly #instanceId = newId();
  /** Set once a probe finds the object has moved on; this instance then stops touching its storage. */
  #instanceLost = false;
  /** Whether an invocation of this instance is already holding its turns, so a second one leaves. */
  #holding = false;
  readonly #logger = createConsoleLogger({ level: configuration.LOG_LEVEL, bindings: { component: 'SessionDO' } });
  /** Public so a test can prove the providers it hands out are bound to this object's bridge. */
  readonly sandboxIntegration: SandboxIntegration;
  /** Code Mode channels the turns in this instance have open; their sandboxes reach them by token. */
  readonly #codeMode = new CodeModeBridgeRegistry();
  /** The desktops the turns in this instance may hold, released when each turn drains. */
  readonly #desktopLeases = new TurnDesktopLeases();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sandboxIntegration = workersSandboxIntegrationFromEnv({
      env,
      codeModeRegistry: this.#codeMode,
      desktopLeases: this.#desktopLeases,
    });
    this.#events = new DurableObjectEventSubscriptions({
      sql: ctx.storage.sql,
      isEvent: isSequencedTurnStreamingEvent,
    });
    void ctx.blockConcurrencyWhile(() => {
      DurableObjectEventSubscriptions.createSchema(ctx.storage.sql);
      createStartedTurnsSchema(ctx.storage.sql);
      return Promise.resolve();
    });
  }

  /** Resolves once the first event is on this object's stream, so an immediate subscribe cannot 412. */
  async startTurn(request: StartTurnRequest): Promise<TurnStartResult> {
    const tooLarge = turnInputTooLarge(request.input);
    if (tooLarge !== undefined) {
      return tooLarge;
    }

    const turnId = newId();
    const persistence = this.#persistence({ session_id: request.session_id, turn_id: turnId });
    const session = await new Sessions({ sessionStore: persistence.sessionStore }).get({
      tenant_id: request.tenant_id,
      session_id: request.session_id,
    });
    if (session === undefined) {
      return { ok: false, status: 404, code: 'not_found', message: `Session not found: ${request.session_id}` };
    }

    // Recorded before createTurn, so the watchdog also finds a turn whose write committed without a reported outcome.
    this.ctx.storage.sql.exec(
      'INSERT INTO started_turns (turn_id, tenant_id, session_id) VALUES (?, ?, ?)',
      turnId,
      request.tenant_id,
      request.session_id,
    );
    const { promise: settled, resolve: settle } = Promise.withResolvers<undefined>();
    this.#running.set(turnId, { session_id: request.session_id, settled });

    const notifier = new TurnCompletionNotifier({
      integrationStore: persistence.integrationStore,
      scheduleStore: persistence.scheduleStore,
      adapters: createIntegrationAdapters(),
      logger: this.#logger,
    });
    let started: Awaited<ReturnType<typeof startTurnInProcess>>;
    try {
      // Work after an RPC invocation ends is not kept alive, so an alarm invocation holds the turn until it settles.
      await this.ctx.storage.setAlarm(Date.now());
      started = await startTurnInProcess({
        session,
        turn_id: turnId,
        active_executor_id: WORKERS_EXECUTOR_ID,
        input: request.input,
        previous_turn_id: request.previous_turn_id,
        userRef: request.user_ref,
        // Gateway metadata headers exist only in TrueFoundry mode, which Workers rejects.
        request_metadata: undefined,
        deps: {
          agentStore: persistence.agentStore,
          modelProviderStore: persistence.modelProviderStore,
          mcpServerStore: persistence.mcpServerStore,
          sandboxProviderStore: persistence.sandboxProviderStore,
          skillStore: persistence.skillStore,
          activeTurns: this.#activeTurns,
          eventSubscriptions: this.#events,
          logger: this.#logger,
          sandboxIntegration: this.sandboxIntegration,
          // Awaited inside `drained`, so the alarm invocation that holds the turn holds this too.
          onTurnDrained: createTurnDrainedHook({
            deliver: input => notifier.deliverForTurn(input),
            desktop: { computers: workersComputersService(this.env), leases: this.#desktopLeases },
            logger: this.#logger,
          }),
        },
      });
    } catch (error) {
      this.#running.delete(turnId);
      settle(undefined);
      const failure = startFailure(error);
      if (failure === undefined) {
        throw error;
      }
      if (failure.code !== 'write_outcome_unknown') {
        this.ctx.storage.sql.exec('DELETE FROM started_turns WHERE turn_id = ?', turnId);
      }
      return failure;
    }

    const finish = (): void => {
      this.#running.delete(turnId);
      settle(undefined);
    };
    // Settles either way, so a failed drain never rejects out of the alarm that awaits it.
    void started.drained.then(finish, finish);
    return { ok: true, turn: toWireTurn(started.turn.record) };
  }

  /**
   * Starts a turn and returns its event stream from the first event in the same call. The creating
   * caller skips subscribe's admission check, which reports a stream expiring within a minute as gone
   * and would drop a turn that finished before the caller subscribed.
   */
  async startTurnStreaming(request: StartTurnRequest): Promise<TurnEventStreamResult> {
    const started = await this.startTurn(request);
    if (!started.ok) {
      return started;
    }
    const streamId = turnStreamId(request.tenant_id, request.session_id, started.turn.id);
    const subscription = this.#events.get(streamId);
    // A stream that is already gone would end the response early, with a 200 and no turn.done.
    if (!subscription.hasLiveTip()) {
      return { ok: false, status: 412, code: 'stream_gone', message: new StreamGoneError(streamId).message };
    }
    return { ok: true, stream: encodeTurnEvents(signal => subscription.poll(undefined, { signal })) };
  }

  async subscribe(request: {
    tenant_id: string;
    session_id: string;
    turn_id: string;
    after_sequence_number: number | undefined;
  }): Promise<TurnEventStreamResult> {
    const subscription = this.#events.get(turnStreamId(request.tenant_id, request.session_id, request.turn_id));
    try {
      await subscription.assertSubscribable();
    } catch (error) {
      if (error instanceof StreamGoneError) {
        return { ok: false, status: 412, code: 'stream_gone', message: error.message };
      }
      throw error;
    }
    return {
      ok: true,
      stream: encodeTurnEvents(signal => subscription.poll(request.after_sequence_number, { signal })),
    };
  }

  /**
   * Pollers parked on a turn's stream in this instance. Tests use it to show that a reader cancelled inside
   * the object releases its poll at once, while one cancelled across RPC stays parked until the next event.
   */
  waitingPollers(request: { tenant_id: string; session_id: string; turn_id: string }): number {
    return this.#events.waitingPollers(turnStreamId(request.tenant_id, request.session_id, request.turn_id));
  }

  /**
   * Unfinished poll generators on a turn's stream in this instance. Tests use it to show that a poll whose
   * reader was cancelled across RPC finishes at the next event instead of staying suspended.
   */
  livePolls(request: { tenant_id: string; session_id: string; turn_id: string }): number {
    return this.#events.livePolls(turnStreamId(request.tenant_id, request.session_id, request.turn_id));
  }

  /**
   * Answers the Code Mode client of a sandbox this session owns. The caller is the workspace's own
   * egress gateway, which picked this object from the workspace name rather than from the request.
   */
  dispatchCodeMode(request: {
    token: string;
    requestJson: string;
    traceCarrier: Record<string, string>;
  }): Promise<CodeModeDispatchOutcome> {
    return this.#codeMode.dispatch(request);
  }

  /** `cancelled: false` means no turn with this id runs in this instance. */
  cancel(request: { session_id: string; turn_id: string; reason: CancellationReason }): {
    ok: true;
    cancelled: boolean;
  } {
    return {
      ok: true,
      cancelled: this.#activeTurns.cancelIfRunning({
        sessionId: request.session_id,
        turnId: request.turn_id,
        abortReason: request.reason,
      }),
    };
  }

  /**
   * Freezes turns D1 still reports running that no longer run here, holds the invocation while this
   * instance's turns run, then prunes expired streams.
   */
  override async alarm(): Promise<void> {
    // The fallback armed below fires 60 seconds in while the holding invocation may still have
    // minutes to run. That second invocation would freeze nothing and park on the same promises,
    // so it only pushes the fallback out and leaves.
    if (this.#holding) {
      // Nothing to re-arm once the object has moved on: the instance that took it over owns the alarm.
      if (!this.#instanceLost) {
        await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_DELAY_MS);
      }
      return;
    }
    this.#logger.info('Session alarm pass started', {
      instanceId: this.#instanceId,
      holding: this.#running.size,
    });
    // Counted from entry, so the orphan passes and the wait together stay inside the wall limit.
    const deadline = Date.now() + ALARM_PASS_BUDGET_MS;
    // Stays true if settling orphans throws outright, so the next alarm retries them.
    let orphansRemain = true;
    try {
      if (this.#running.size > 0) {
        // Cloudflare retries a failed alarm a few times; this fallback is a safeguard on top, freezing the held turns.
        await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_DELAY_MS);
      }
      try {
        orphansRemain = await this.#freezeOrphans();
      } catch (error) {
        // A failed orphan pass must not stop this invocation from holding the running turns.
        this.#logger.error('Watchdog could not read the turns this Durable Object started', {
          instanceId: this.#instanceId,
          ...extractErrorLogFields(error),
        });
        orphansRemain = true;
      }
      const held = await this.#holdRunningTurns(deadline);
      if (held === 'settled' || held === 'budget') {
        // Clears the rows of the turns that just settled, and any whose start failed meanwhile.
        orphansRemain = await this.#freezeOrphans();
      }
    } finally {
      // A superseded instance owns nothing: its storage throws, and the instance that took the
      // object over is the one that must re-arm. Ending the pass quietly keeps the invocation's
      // outcome honest about whose work was lost.
      if (this.#instanceLost) {
        this.#logger.warn('Session alarm pass ended on an instance the object had moved away from', {
          instanceId: this.#instanceId,
          holding: this.#running.size,
        });
      } else {
        const now = Date.now();
        this.#events.deleteExpired(now);
        if (this.#running.size > 0) {
          // The pass budget ran out; the next invocation keeps holding the turns.
          await this.ctx.storage.setAlarm(now);
        } else if (orphansRemain) {
          await this.ctx.storage.setAlarm(now + WATCHDOG_DELAY_MS);
        } else {
          const nextExpiry = this.#events.nextExpiry(now);
          if (nextExpiry !== undefined) {
            await this.ctx.storage.setAlarm(nextExpiry);
          }
        }
      }
    }
  }

  /** Returns whether an orphan is left for a later alarm because settling it failed. */
  async #freezeOrphans(): Promise<boolean> {
    const orphans = this.ctx.storage.sql
      .exec<StartedTurnRow>('SELECT turn_id, tenant_id, session_id, attempts, first_failed_at FROM started_turns')
      .toArray()
      .filter(row => !this.#running.has(row.turn_id));
    if (orphans.length === 0) {
      return false;
    }
    let failed = false;
    // Shared by the whole pass, so its statement count covers every orphan it settles.
    let persistence: ReturnType<typeof createD1Persistence> | undefined;
    for (const orphan of orphans) {
      try {
        // Opened inside the guard, so a failure to open the stores is recorded against this orphan.
        persistence ??= this.#persistence({ watchdog: true });
        const sessions = new Sessions({ sessionStore: persistence.sessionStore });
        const turn = await persistence.sessionStore.getTurn({
          session_id: orphan.session_id,
          turn_id: orphan.turn_id,
        });
        if (turn?.state.status === 'running') {
          const session = await sessions.get({ tenant_id: orphan.tenant_id, session_id: orphan.session_id });
          if (session !== undefined) {
            await freezeTurnIgnoringMissing(session, { turnId: orphan.turn_id, reason: CancellationReason.Abandoned });
            this.#logger.warn('Froze a running turn this Durable Object no longer executes', {
              sessionId: orphan.session_id,
              turnId: orphan.turn_id,
            });
          }
        }
        this.ctx.storage.sql.exec('DELETE FROM started_turns WHERE turn_id = ?', orphan.turn_id);
      } catch (error) {
        // One orphan that cannot be settled must not block the others or the re-arm.
        failed = this.#recordOrphanFailure({ orphan, error }) || failed;
      }
    }
    return failed;
  }

  /** Returns whether the orphan stays for a retry; an orphan that will never settle is dropped with an error. */
  #recordOrphanFailure({ orphan, error }: { orphan: StartedTurnRow; error: unknown }): boolean {
    const now = Date.now();
    const attempts = orphan.attempts + 1;
    const firstFailedAt = orphan.first_failed_at ?? now;
    const logFields = {
      sessionId: orphan.session_id,
      turnId: orphan.turn_id,
      attempts,
      firstFailedAt: new Date(firstFailedAt).toISOString(),
      ...extractErrorLogFields(error),
    };
    // A value D1 refuses fails the same way on every retry.
    const permanent = error instanceof D1ValueTooLargeError;
    if (permanent || now - firstFailedAt >= WATCHDOG_RETRY_WINDOW_MS) {
      this.ctx.storage.sql.exec('DELETE FROM started_turns WHERE turn_id = ?', orphan.turn_id);
      this.#logger.error(
        permanent
          ? 'Watchdog dropped an orphaned turn it can never settle; the turn may stay running in D1'
          : 'Watchdog gave up on an orphaned turn after an hour of failures; the turn may stay running in D1',
        logFields,
      );
      return false;
    }
    this.ctx.storage.sql.exec(
      'UPDATE started_turns SET attempts = ?, first_failed_at = ? WHERE turn_id = ?',
      attempts,
      firstFailedAt,
      orphan.turn_id,
    );
    this.#logger.warn('Watchdog could not settle an orphaned turn; retrying on the next alarm', logFields);
    return true;
  }

  /**
   * Holds the invocation until no turn runs in this instance, including turns started while waiting,
   * until the pass deadline, or until the object has moved to another instance.
   */
  async #holdRunningTurns(deadline: number): Promise<HoldOutcome | 'none'> {
    if (this.#running.size === 0) {
      return 'none';
    }
    const { promise: budgetSpent, resolve: spend } = Promise.withResolvers<HoldOutcome>();
    const budget = setTimeout(
      () => {
        spend('budget');
      },
      Math.max(0, deadline - Date.now()),
    );
    const stopProbing = new AbortController();
    const lost = this.#awaitInstanceLost(stopProbing.signal);
    this.#holding = true;
    try {
      let outcome: HoldOutcome = 'settled';
      do {
        // Settling the current set only re-checks the map, which may hold turns started meanwhile.
        outcome = await Promise.race([
          Promise.all([...this.#running.values()].map(turn => turn.settled)).then<HoldOutcome>(() => 'settled'),
          budgetSpent,
          lost,
        ]);
      } while (this.#running.size > 0 && outcome === 'settled');
      if (outcome === 'lost') {
        this.#abandonRunningTurns();
      }
      return outcome;
    } finally {
      this.#holding = false;
      clearTimeout(budget);
      stopProbing.abort();
    }
  }

  /**
   * Resolves when this instance no longer owns the object. Nothing tells a superseded instance that
   * it has been replaced, so a turn parked on a model call or a computer command would run on for
   * minutes and write its events into storage that has stopped answering.
   */
  async #awaitInstanceLost(stop: AbortSignal): Promise<HoldOutcome> {
    for (;;) {
      await new Promise<void>(resolve => setTimeout(resolve, INSTANCE_LIVENESS_PROBE_MS));
      if (stop.aborted) {
        // The hold is over and something else won the race; never settling leaves it untouched.
        return new Promise<HoldOutcome>(() => undefined);
      }
      try {
        await probeInstanceAlive(this.ctx.storage);
      } catch (error) {
        this.#instanceLost = true;
        this.#logger.warn('This Durable Object instance no longer owns the object; abandoning its turns', {
          instanceId: this.#instanceId,
          holding: this.#running.size,
          ...extractErrorLogFields(error),
        });
        return 'lost';
      }
    }
  }

  /**
   * Stops the turns of an instance that has been replaced. Without it they end as `client-cancelled`
   * whenever the drain's next write finds the storage gone, which reads as the caller's doing.
   */
  #abandonRunningTurns(): void {
    for (const [turnId, turn] of this.#running) {
      this.#activeTurns.cancelIfRunning({
        sessionId: turn.session_id,
        turnId,
        abortReason: CancellationReason.Abandoned,
      });
    }
  }

  /** Fresh stores per turn or watchdog pass, so the statement count covers one turn or one pass. */
  #persistence(logFields: Record<string, unknown>) {
    let statements = 0;
    return createD1Persistence({
      database: this.env.DB,
      mcpClientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
      onStatements: count => {
        const before = statements;
        statements += count;
        if (before <= D1_TURN_STATEMENT_WARNING && statements > D1_TURN_STATEMENT_WARNING) {
          this.#logger.warn('Turn crossed the D1 statement warning threshold across its start and alarm invocations', {
            ...logFields,
            statements,
            threshold: D1_TURN_STATEMENT_WARNING,
          });
        }
      },
    });
  }
}
