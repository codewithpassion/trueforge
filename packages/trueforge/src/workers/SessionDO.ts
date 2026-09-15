import {
  CancellationReason,
  Sessions,
  type TurnInputItem,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { DurableObject } from 'cloudflare:workers';
import configuration from '../config';
import { D1_MAX_VALUE_BYTES, D1ValueTooLargeError, D1WriteOutcomeUnknownError } from '../db/d1/client';
import { createD1Persistence } from '../db/d1/persistence';
import { ActiveTurnRegistry } from '../runtime/activeTurns';
import { StreamGoneError } from '../runtime/event-subscription';
import {
  freezeTurnIgnoringMissing,
  turnStartFailure,
  type TurnExecutorFailure,
  type TurnStartResult,
} from '../runtime/turnExecutor';
import { startTurnInProcess, toWireTurn, turnStreamId } from '../runtime/turnRunner';
import { newId } from '../utils/id';
import { DurableObjectEventSubscriptions } from './durableObjectEventSubscriptions';
import type { Env } from './env';
import { createConsoleLogger } from './logger';
import { encodeTurnEvents, isSequencedTurnStreamingEvent } from './turnEventWire';

/** A pending timer blocks hibernation while a turn runs. */
const KEEPALIVE_INTERVAL_MS = 20_000;
/** The watchdog alarm fires this long after the last keepalive tick. */
const WATCHDOG_DELAY_MS = 60_000;
/** D1 allows 1000 queries per invocation; a turn past this many statements is close to failing. */
export const D1_TURN_STATEMENT_WARNING = 800;

export interface StartTurnRequest {
  tenant_id: string;
  session_id: string;
  input: TurnInputItem[] | undefined;
  previous_turn_id: string | undefined;
  user_ref: string;
}

export type SubscribeTurnResult = { ok: true; stream: ReadableStream<Uint8Array> } | TurnExecutorFailure;

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
  /** Turns between their start request and the end of their drain in this instance. */
  readonly #running = new Set<string>();
  readonly #logger = createConsoleLogger({ level: configuration.LOG_LEVEL, bindings: { component: 'SessionDO' } });
  #keepalive: ReturnType<typeof setInterval> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#events = new DurableObjectEventSubscriptions({
      sql: ctx.storage.sql,
      isEvent: isSequencedTurnStreamingEvent,
    });
    void ctx.blockConcurrencyWhile(() => {
      DurableObjectEventSubscriptions.createSchema(ctx.storage.sql);
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS started_turns (
          turn_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL
        )`,
      );
      return Promise.resolve();
    });
  }

  /** Resolves once the first event is on this object's stream, so an immediate subscribe cannot 412. */
  async startTurn(request: StartTurnRequest): Promise<TurnStartResult> {
    const inputBytes = new TextEncoder().encode(JSON.stringify(request.input ?? [])).byteLength;
    if (inputBytes > D1_MAX_VALUE_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'turn_input_too_large',
        message: `Turn input is ${String(inputBytes)} bytes; the limit is ${String(D1_MAX_VALUE_BYTES)} bytes`,
      };
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
    this.#running.add(turnId);
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_DELAY_MS);

    let started: Awaited<ReturnType<typeof startTurnInProcess>>;
    try {
      started = await startTurnInProcess({
        session,
        turn_id: turnId,
        input: request.input,
        previous_turn_id: request.previous_turn_id,
        userRef: request.user_ref,
        deps: {
          agentStore: persistence.agentStore,
          modelProviderStore: persistence.modelProviderStore,
          mcpServerStore: persistence.mcpServerStore,
          sandboxProviderStore: persistence.sandboxProviderStore,
          skillStore: persistence.skillStore,
          activeTurns: this.#activeTurns,
          eventSubscriptions: this.#events,
          logger: this.#logger,
          sandboxIntegration: undefined,
        },
      });
    } catch (error) {
      this.#running.delete(turnId);
      const failure = startFailure(error);
      if (failure === undefined) {
        throw error;
      }
      if (failure.code !== 'write_outcome_unknown') {
        this.ctx.storage.sql.exec('DELETE FROM started_turns WHERE turn_id = ?', turnId);
      }
      return failure;
    }

    this.#keepAliveUntil(turnId, started.drained);
    return { ok: true, turn: toWireTurn(started.turn.record) };
  }

  async subscribe(request: {
    tenant_id: string;
    session_id: string;
    turn_id: string;
    after_sequence_number: number | undefined;
  }): Promise<SubscribeTurnResult> {
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

  /** Watchdog: freezes turns D1 still reports running that no longer run here, then prunes expired streams. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.#events.deleteExpired(now);

    const orphans = this.ctx.storage.sql
      .exec<{ turn_id: string; tenant_id: string; session_id: string }>(
        'SELECT turn_id, tenant_id, session_id FROM started_turns',
      )
      .toArray()
      .filter(row => !this.#running.has(row.turn_id));
    if (orphans.length > 0) {
      const persistence = this.#persistence({ watchdog: true });
      const sessions = new Sessions({ sessionStore: persistence.sessionStore });
      for (const orphan of orphans) {
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
      }
    }

    if (this.#running.size > 0) {
      await this.ctx.storage.setAlarm(now + WATCHDOG_DELAY_MS);
      return;
    }
    const nextExpiry = this.#events.nextExpiry(now);
    if (nextExpiry !== undefined) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
  }

  #keepAliveUntil(turnId: string, drained: Promise<void>): void {
    this.#keepalive ??= setInterval(() => {
      void this.ctx.storage.setAlarm(Date.now() + WATCHDOG_DELAY_MS);
    }, KEEPALIVE_INTERVAL_MS);
    const settled = drained.finally(() => {
      this.#running.delete(turnId);
      if (this.#running.size === 0) {
        clearInterval(this.#keepalive);
        this.#keepalive = undefined;
      }
    });
    this.ctx.waitUntil(settled);
  }

  /** Fresh stores per turn so the statement count covers exactly one turn. */
  #persistence(logFields: Record<string, unknown>) {
    let statements = 0;
    return createD1Persistence({
      database: this.env.DB,
      mcpClientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
      onStatements: count => {
        const before = statements;
        statements += count;
        if (before <= D1_TURN_STATEMENT_WARNING && statements > D1_TURN_STATEMENT_WARNING) {
          this.#logger.warn('Turn crossed the D1 statement warning threshold for one invocation', {
            ...logFields,
            statements,
            threshold: D1_TURN_STATEMENT_WARNING,
          });
        }
      },
    });
  }
}
