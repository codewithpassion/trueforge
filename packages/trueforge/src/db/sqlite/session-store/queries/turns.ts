import type { SessionMetrics } from '@truefoundry/trueforge-core/agent-session';
import type { TurnRecord, TurnSnapshot } from '@truefoundry/trueforge-core/agent-session/models/TurnRecord';
import {
  type TerminalTurnState,
  type TurnInputItem,
  type TurnState,
} from '@truefoundry/trueforge-core/agent-session/schemas/turn';
import { assertCreateTurnThreadDelta } from '@truefoundry/trueforge-core/agent-session/store/assertCreateTurnThreadDelta';
import type {
  FreezeAndGetTurnInput,
  TurnRecordWithoutSnapshot,
  UpdateTurnStateInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  PreviousTurnRunningError,
  SessionNotFoundError,
  SessionStoreInvariantError,
  TurnAlreadyExistsError,
  TurnNotFoundError,
  TurnNotRunningError,
} from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import type { CapabilityState, JsonValue } from '@truefoundry/trueforge-core/core/capabilities/AgentCapability';
import type { AgentInfo, AgentParent, MCPServerInitInfo } from '@truefoundry/trueforge-core/core/events/schema';
import type { AgentThreadSnapshot, ContextMessage } from '@truefoundry/trueforge-core/core/runtime/AgentThread.types';
import type { CurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import { getEmptyCurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import type { SandboxInfo } from '@truefoundry/trueforge-core/core/sandbox/Sandbox';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import type { AtomicRunner, BatchStatementResult } from '../../atomic';
import { isUniqueViolation } from '../../errors';
import { jsonbBind, jsonText, nowIso } from '../../sqlExpressions';
import type { Database, TurnCheckpoint, TurnThreadCheckpoint } from '../../types';
import {
  appendContextQueries,
  insertCapabilityStatesQueries,
  insertTurnThreadsQueries,
  turnRunning,
  type CapabilityStateRow,
  type ContextAppendRow,
  type TurnKeys,
  type TurnThreadRow,
} from '../sqlExpressions';

type TurnCustom = Record<string, never>;

function isEmptyCustomRecord(value: Record<string, unknown>): value is TurnCustom {
  return Object.keys(value).length === 0;
}

function parseTurnCustom(value: Record<string, unknown> | null): TurnCustom | null {
  if (value === null) {
    return null;
  }
  if (!isEmptyCustomRecord(value)) {
    throw new SessionStoreInvariantError('non-empty turn custom is not supported');
  }
  return value;
}

/** New thread metadata; mutable per-turn data arrives through dedicated fields. */
export interface NewThreadRegistration {
  thread_id: string;
  parent: AgentParent | null;
  agent_info: AgentInfo | null;
}

export interface NewContextAppend {
  thread_id: string;
  context: ContextMessage[];
  current_context_usage: CurrentContextUsage | null;
}

export interface CreateTurnTurnFields {
  turn_id: string;
  first_turn_id: string;
  previous_turn_id: string | null;
  ancestor_ids: string[];
  input: TurnInputItem[];
  state: TurnState;
  custom: Record<string, unknown> | null;
}

export interface CreateTurnInput {
  session_id: string;
  turn: CreateTurnTurnFields;
  new_threads: NewThreadRegistration[];
  new_context_appends: NewContextAppend[];
  capability_states: {
    thread_id: string;
    capability_state: CapabilityState | null;
  }[];
  last_activity_timestamp_ms: number;
  update_session_title_if_not_exist: string | null;
  mcp_servers: Record<string, MCPServerInitInfo> | null;
  sandbox_info: SandboxInfo | null;
}

export interface GetTurnInput {
  session_id: string;
  turn_id: string;
}

export interface ListTurnsInput {
  session_id: string;
  limit: number;
  offset: number;
}

export interface ListTurnsResult {
  turns: TurnRecordWithoutSnapshot<TurnCustom>[];
  next_offset: number | null;
}

type DbOrTrx = Kysely<Database>;

/**
 * Running → terminal as one batch. The event insert goes first because its `changes` is
 * decisive; the metrics fold and state flip then require "still running AND this event
 * exists", which only that insert can make true (a pre-existing event id errors instead).
 */
function terminalTransitionQueries(
  db: Kysely<Database>,
  input: {
    keys: TurnKeys;
    state: TerminalTurnState;
    turn_created_at: string;
    turn_done_event: UpdateTurnStateInput['turn_done_event'];
  },
): CompiledQuery[] {
  const { keys, state, turn_done_event } = input;
  const eventWritten = sql<boolean>`EXISTS (
    SELECT 1 FROM session_event
    WHERE session_id = ${keys.session_id} AND turn_id = ${keys.turn_id} AND event_id = ${turn_done_event.id}
  )`;
  const insertEvent = db
    .insertInto('session_event')
    .columns(['session_id', 'turn_id', 'event_id', 'event', 'created_at'])
    .expression(
      sql`SELECT session_id, turn_id, ${turn_done_event.id}, ${jsonbBind(turn_done_event)}, ${turn_done_event.created_at}
        FROM turn
        WHERE session_id = ${keys.session_id} AND turn_id = ${keys.turn_id} AND state->>'status' = 'running'`,
    )
    .compile();

  const elapsed_ms = Date.parse(state.completed_at) - Date.parse(input.turn_created_at);
  const total_duration_ms = elapsed_ms > 0 ? Math.trunc(elapsed_ms) : 0;
  const turnCost = state.metrics?.total_cost_in_usd;
  const withDuration = sql<SessionMetrics>`jsonb_set(
    metrics,
    '$.total_duration_ms',
    jsonb((metrics->>'total_duration_ms') + ${total_duration_ms})
  )`;
  const foldMetrics = db
    .updateTable('session')
    .set({
      metrics:
        turnCost === undefined
          ? withDuration
          : sql<SessionMetrics>`jsonb_set(
              ${withDuration},
              '$.total_cost_in_usd',
              jsonb(COALESCE(metrics->>'total_cost_in_usd', 0) + ${turnCost})
            )`,
    })
    .where('session_id', '=', keys.session_id)
    .where(turnRunning(keys))
    .where(eventWritten)
    .compile();

  const flipState = db
    .updateTable('turn')
    .set({ state: jsonbBind(state), updated_at: nowIso() })
    .where('session_id', '=', keys.session_id)
    .where('turn_id', '=', keys.turn_id)
    .where(sql<boolean>`state->>'status' = 'running'`)
    .where(eventWritten)
    .compile();

  return [insertEvent, foldMetrics, flipState];
}

async function loadTurnForTransition(
  db: DbOrTrx,
  keys: TurnKeys,
): Promise<{ state: TurnState; created_at: string } | undefined> {
  return await db
    .selectFrom('turn')
    .select([jsonText<TurnState>(sql.ref('state')).as('state'), 'created_at'])
    .where('session_id', '=', keys.session_id)
    .where('turn_id', '=', keys.turn_id)
    .executeTakeFirst();
}

function terminalTurnState(state: TurnState, turn_id: string): TerminalTurnState {
  switch (state.status) {
    case 'running':
      throw new SessionStoreInvariantError(`expected terminal state for turn ${turn_id}, got running`);
    case 'done':
    case 'cancelled':
    case 'error':
      return state;
  }
}

async function loadTurnState(db: DbOrTrx, keys: TurnKeys): Promise<TurnState | undefined> {
  const row = await db
    .selectFrom('turn')
    .select([jsonText<TurnState>(sql.ref('state')).as('state')])
    .where('session_id', '=', keys.session_id)
    .where('turn_id', '=', keys.turn_id)
    .executeTakeFirst();
  return row?.state;
}

/** Classify a 0-row fenced write: missing turn vs frozen/non-running turn. */
export async function classifyTurnFenceWriteFailure(db: DbOrTrx, keys: TurnKeys): Promise<never> {
  const state = await loadTurnState(db, keys);
  if (!state) {
    throw new TurnNotFoundError(keys.turn_id);
  }
  throw new TurnNotRunningError(keys.turn_id, terminalTurnState(state, keys.turn_id));
}

/**
 * Classify a 0-row fenced turn_thread UPDATE: turn missing/terminal vs thread row missing.
 */
export async function classifyTurnThreadWriteFailure(db: DbOrTrx, keys: TurnKeys, thread_id: string): Promise<never> {
  const state = await loadTurnState(db, keys);
  if (!state) {
    throw new TurnNotFoundError(keys.turn_id);
  }
  if (state.status !== 'running') {
    throw new TurnNotRunningError(keys.turn_id, terminalTurnState(state, keys.turn_id));
  }
  throw new SessionStoreInvariantError(`thread ${thread_id} not found in turn ${keys.turn_id}`);
}

export async function assertTurnRunning(db: DbOrTrx, keys: TurnKeys): Promise<void> {
  const state = await loadTurnState(db, keys);
  if (!state) {
    throw new TurnNotFoundError(keys.turn_id);
  }
  if (state.status !== 'running') {
    throw new TurnNotRunningError(keys.turn_id, terminalTurnState(state, keys.turn_id));
  }
}

interface CapabilityAggRow {
  thread_id: string;
  capability_state: Record<string, JsonValue> | null;
}

async function assembleTurnRecord(
  db: DbOrTrx,
  args: { session_id: string; turn_id: string },
): Promise<TurnRecord<TurnCustom> | undefined> {
  const turn = await db
    .selectFrom('turn')
    .select([
      'session_id',
      'turn_id',
      'first_turn_id',
      'previous_turn_id',
      jsonText<string[]>(sql.ref('ancestor_ids')).as('ancestor_ids'),
      jsonText<TurnInputItem[]>(sql.ref('input')).as('input'),
      jsonText<TurnState>(sql.ref('state')).as('state'),
      jsonText<TurnCheckpoint>(sql.ref('checkpoint')).as('checkpoint'),
      jsonText<Record<string, unknown> | null>(sql.ref('custom')).as('custom'),
      'created_at',
      'updated_at',
    ])
    .where('session_id', '=', args.session_id)
    .where('turn_id', '=', args.turn_id)
    .executeTakeFirst();

  if (!turn) {
    return undefined;
  }

  // LEFT JOIN turn_thread + turn_thread_context ORDER BY pos to assemble context per thread.
  // Empty-context threads emit one row with null pos/append_id from the LEFT JOIN.
  const contextRows = await db
    .selectFrom('turn_thread as tt')
    .leftJoin('turn_thread_context as ttc', join =>
      join
        .on('ttc.session_id', '=', args.session_id)
        .on('ttc.turn_id', '=', args.turn_id)
        .onRef('ttc.thread_id', '=', 'tt.thread_id'),
    )
    .leftJoin('thread_context_log as l', join =>
      join
        .on('l.session_id', '=', args.session_id)
        .onRef('l.thread_id', '=', 'tt.thread_id')
        .onRef('l.append_id', '=', 'ttc.append_id'),
    )
    .select([
      'tt.thread_id',
      jsonText<TurnThreadCheckpoint>(sql.ref('tt.checkpoint')).as('checkpoint'),
      jsonText<AgentInfo | null>(sql.ref('tt.agent_info')).as('agent_info'),
      jsonText<CurrentContextUsage>(sql.ref('tt.current_context_usage')).as('current_context_usage'),
      jsonText<ContextMessage | null>(sql.ref('l.body')).as('body'),
      'ttc.pos',
    ])
    .where('tt.session_id', '=', args.session_id)
    .where('tt.turn_id', '=', args.turn_id)
    .orderBy('tt.thread_id')
    .orderBy('ttc.pos')
    .execute();

  const capabilityRows: CapabilityAggRow[] = await db
    .selectFrom('thread_capability_state')
    .select([
      'thread_id',
      sql<Record<string, JsonValue> | null>`json(jsonb_group_object(key, json(state)))`.as('capability_state'),
    ])
    .where('session_id', '=', args.session_id)
    .where('turn_id', '=', args.turn_id)
    .groupBy('thread_id')
    .execute();

  const capabilityByThread = new Map<string, Record<string, JsonValue>>();
  for (const row of capabilityRows) {
    if (row.capability_state !== null) {
      capabilityByThread.set(row.thread_id, row.capability_state);
    }
  }

  const threads: Record<string, AgentThreadSnapshot> = {};
  const orderedBodies = new Map<string, ContextMessage[]>();
  const threadMeta = new Map<
    string,
    {
      checkpoint: TurnThreadCheckpoint;
      agent_info: AgentInfo | null;
      current_context_usage: CurrentContextUsage;
    }
  >();

  for (const row of contextRows) {
    if (!threadMeta.has(row.thread_id)) {
      threadMeta.set(row.thread_id, {
        checkpoint: row.checkpoint,
        agent_info: row.agent_info,
        current_context_usage: row.current_context_usage,
      });
      orderedBodies.set(row.thread_id, []);
    }
    if (row.body !== null) {
      const bodies = orderedBodies.get(row.thread_id);
      if (bodies !== undefined) {
        bodies.push(row.body);
      }
    }
  }

  for (const [threadId, meta] of threadMeta) {
    const context = orderedBodies.get(threadId) ?? [];
    const capability_state = capabilityByThread.get(threadId) ?? null;

    const snap: AgentThreadSnapshot = {
      thread_id: threadId,
      context,
      current_context_usage: meta.current_context_usage,
      parent: meta.checkpoint.parent,
      agent_info: meta.agent_info,
      completion: meta.checkpoint.completion,
      capability_state,
    };
    threads[threadId] = snap;
  }

  const checkpoint = turn.checkpoint;
  const snapshot: TurnSnapshot = {
    threads,
    mcp_servers: checkpoint.mcp_servers,
    sandbox_info: checkpoint.sandbox_info,
  };

  return {
    turn_id: turn.turn_id,
    session_id: turn.session_id,
    first_turn_id: turn.first_turn_id,
    ancestor_ids: turn.ancestor_ids,
    previous_turn_id: turn.previous_turn_id,
    state: turn.state,
    input: turn.input,
    snapshot,
    created_at: new Date(turn.created_at),
    updated_at: new Date(turn.updated_at),
    custom: parseTurnCustom(turn.custom),
  };
}

/**
 * createTurn — reads and validation, then one conditional-chain batch. Statement 1 inserts
 * the turn only while the session exists and the previous turn is not running; every later
 * statement requires the new turn row. Tip equality is not checked, so concurrent forks from
 * one finished turn both succeed. Context order lives in turn_thread_context (pos, append_id).
 */
export async function createTurn(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  input: CreateTurnInput,
): Promise<void> {
  const session = await db
    .selectFrom('session')
    .select(['last_turn_id'])
    .where('session_id', '=', input.session_id)
    .executeTakeFirst();
  if (!session) {
    throw new SessionNotFoundError(input.session_id);
  }

  const prevTurnId = input.turn.previous_turn_id;

  let prevCheckpoint: TurnCheckpoint | null = null;
  const prevThreadRows: TurnThreadRow[] = [];

  if (prevTurnId != null) {
    // Terminal turns are immutable, so this read stays valid; the batch re-checks "not running".
    const prevRows = await db
      .selectFrom('turn as t')
      .leftJoin('turn_thread as tt', join =>
        join.onRef('tt.session_id', '=', 't.session_id').onRef('tt.turn_id', '=', 't.turn_id'),
      )
      .select([
        jsonText<TurnCheckpoint>(sql.ref('t.checkpoint')).as('turn_checkpoint'),
        jsonText<TurnState>(sql.ref('t.state')).as('turn_state'),
        'tt.thread_id',
        jsonText<TurnThreadCheckpoint | null>(sql.ref('tt.checkpoint')).as('thread_checkpoint'),
        jsonText<AgentInfo | null>(sql.ref('tt.agent_info')).as('agent_info'),
        jsonText<CurrentContextUsage | null>(sql.ref('tt.current_context_usage')).as('current_context_usage'),
      ])
      .where('t.session_id', '=', input.session_id)
      .where('t.turn_id', '=', prevTurnId)
      .execute();

    const first = prevRows[0];
    if (first !== undefined) {
      if (first.turn_state.status === 'running') {
        throw new PreviousTurnRunningError(prevTurnId);
      }
      prevCheckpoint = first.turn_checkpoint;

      for (const row of prevRows) {
        if (row.thread_id === null) {
          continue;
        }
        if (row.thread_checkpoint === null || row.current_context_usage === null) {
          throw new SessionStoreInvariantError(`previous turn_thread row for ${row.thread_id} is incomplete`);
        }
        prevThreadRows.push({
          thread_id: row.thread_id,
          checkpoint: row.thread_checkpoint,
          agent_info: row.agent_info,
          current_context_usage: row.current_context_usage,
        });
      }
    }
  }

  assertCreateTurnThreadDelta({
    previousThreadIds: new Set(prevThreadRows.map(r => r.thread_id)),
    new_threads: input.new_threads,
    new_context_appends: input.new_context_appends,
    capability_states: input.capability_states,
  });

  const checkpoint: TurnCheckpoint = {
    mcp_servers: input.mcp_servers ?? prevCheckpoint?.mcp_servers ?? null,
    sandbox_info: input.sandbox_info ?? prevCheckpoint?.sandbox_info ?? null,
  };
  const now = nowIso();
  const turnCustom = input.turn.custom ?? null;
  const keys: TurnKeys = { session_id: input.session_id, turn_id: input.turn.turn_id };
  // Matches only the row statement 1 writes: it errors instead when the turn id already exists.
  const created = sql<boolean>`EXISTS (
    SELECT 1 FROM turn
    WHERE session_id = ${keys.session_id} AND turn_id = ${keys.turn_id}
      AND created_at = ${now} AND previous_turn_id IS ${prevTurnId ?? null}
  )`;

  const previousNotRunning =
    prevTurnId == null
      ? sql``
      : sql` AND NOT EXISTS (
          SELECT 1 FROM turn
          WHERE session_id = ${input.session_id} AND turn_id = ${prevTurnId} AND state->>'status' = 'running'
        )`;
  const insertTurn = db
    .insertInto('turn')
    .columns([
      'session_id',
      'turn_id',
      'first_turn_id',
      'previous_turn_id',
      'ancestor_ids',
      'input',
      'state',
      'checkpoint',
      'custom',
      'created_at',
      'updated_at',
    ])
    .expression(
      sql`SELECT ${input.session_id}, ${input.turn.turn_id}, ${input.turn.first_turn_id}, ${prevTurnId ?? null},
          ${jsonbBind(input.turn.ancestor_ids)}, ${jsonbBind(input.turn.input)}, ${jsonbBind(input.turn.state)},
          ${jsonbBind(checkpoint)}, ${turnCustom !== null ? jsonbBind(turnCustom) : null}, ${now}, ${now}
        FROM session
        WHERE session_id = ${input.session_id}${previousNotRunning}`,
    )
    .compile();

  const titleValue = input.update_session_title_if_not_exist;
  const updateSession = db
    .updateTable('session')
    .set({
      last_turn_id: input.turn.turn_id,
      updated_at: now,
      last_activity_timestamp_ms: input.last_activity_timestamp_ms,
      metrics: sql`jsonb_set(metrics, '$.total_turns', jsonb((metrics->>'total_turns') + 1))`,
      ...(titleValue !== null ? { title: sql<string>`COALESCE(title, ${titleValue})` } : {}),
    })
    .where('session_id', '=', input.session_id)
    .where(created)
    .compile();

  const queries: CompiledQuery[] = [insertTurn, updateSession];

  const appendUsageByThread = new Map<string, CurrentContextUsage>();
  for (const append of input.new_context_appends) {
    if (append.current_context_usage !== null) {
      appendUsageByThread.set(append.thread_id, append.current_context_usage);
    }
  }

  const turnThreadRows: TurnThreadRow[] = prevThreadRows.map(parent => ({
    ...parent,
    current_context_usage: appendUsageByThread.get(parent.thread_id) ?? parent.current_context_usage,
  }));
  for (const nt of input.new_threads) {
    turnThreadRows.push({
      thread_id: nt.thread_id,
      checkpoint: { parent: nt.parent, completion: null },
      agent_info: nt.agent_info,
      current_context_usage: appendUsageByThread.get(nt.thread_id) ?? getEmptyCurrentContextUsage(),
    });
  }
  if (turnThreadRows.length > 0) {
    queries.push(...insertTurnThreadsQueries(db, { keys, rows: turnThreadRows, guard: created, updated_at: now }));
  }

  // Carried-forward mapping first, so appended rows number after the parent's max pos.
  if (prevTurnId != null && prevThreadRows.length > 0) {
    queries.push(
      db
        .insertInto('turn_thread_context')
        .columns(['session_id', 'turn_id', 'thread_id', 'pos', 'append_id'])
        .expression(
          sql`SELECT session_id, ${input.turn.turn_id}, thread_id, pos, append_id
            FROM turn_thread_context
            WHERE session_id = ${input.session_id}
              AND turn_id = ${prevTurnId}
              AND thread_id IN (SELECT thread_id FROM turn_thread WHERE session_id = ${input.session_id} AND turn_id = ${prevTurnId})
              AND ${created}`,
        )
        .compile(),
    );
  }

  const appendRows: ContextAppendRow[] = input.new_context_appends.flatMap(append =>
    append.context.map(body => ({ thread_id: append.thread_id, body })),
  );
  queries.push(...appendContextQueries(db, { keys, rows: appendRows, guard: created, created_at: now }));

  const capabilityRows: CapabilityStateRow[] = [];
  for (const capability of input.capability_states) {
    if (capability.capability_state === null) {
      continue;
    }
    for (const [key, state] of Object.entries(capability.capability_state)) {
      capabilityRows.push({ thread_id: capability.thread_id, key, state });
    }
  }
  if (capabilityRows.length > 0) {
    queries.push(...insertCapabilityStatesQueries(db, { keys, rows: capabilityRows, guard: created, updated_at: now }));
  }

  let results: readonly BatchStatementResult[];
  try {
    results = await atomic.batchWrite({ executor: db, queries });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TurnAlreadyExistsError(input.turn.turn_id, { cause: err });
    }
    throw err;
  }
  if ((results[0]?.changes ?? 0) === 0) {
    await classifyCreateTurnGuardFailure(db, { session_id: input.session_id, previous_turn_id: prevTurnId });
  }
}

/** Statement 1 matched no session row, or the previous turn was running when the batch ran. */
async function classifyCreateTurnGuardFailure(
  db: DbOrTrx,
  args: { session_id: string; previous_turn_id: string | null },
): Promise<never> {
  const session = await db
    .selectFrom('session')
    .select(['session_id'])
    .where('session_id', '=', args.session_id)
    .executeTakeFirst();
  if (!session) {
    throw new SessionNotFoundError(args.session_id);
  }
  if (args.previous_turn_id !== null) {
    throw new PreviousTurnRunningError(args.previous_turn_id);
  }
  throw new SessionStoreInvariantError(`createTurn guard rejected turn for session ${args.session_id}`);
}

/**
 * freezeAndGetTurn — cancel if still running, then return the assembled record.
 * Terminal turns are returned unchanged (freeze is a plain read).
 */
export async function freezeAndGetTurn(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  input: FreezeAndGetTurnInput,
): Promise<TurnRecord> {
  const keys: TurnKeys = { session_id: input.session_id, turn_id: input.turn_id };
  const current = await loadTurnForTransition(db, keys);
  if (current?.state.status === 'running') {
    const cancelledState: TerminalTurnState = {
      status: 'cancelled',
      reason: input.reason,
      completed_at: nowIso(),
    };
    // Zero changes means another terminal write won; the read below returns its result.
    await atomic.batchWrite({
      executor: db,
      queries: terminalTransitionQueries(db, {
        keys,
        state: cancelledState,
        turn_created_at: current.created_at,
        turn_done_event: input.turn_done_event,
      }),
    });
  }

  const record = await getTurn(atomic, input);
  if (!record) {
    throw new TurnNotFoundError(input.turn_id);
  }
  return record;
}

/** getTurn — assembleTurnRecord's SELECTs share one read group. */
export async function getTurn(
  atomic: AtomicRunner<Database>,
  input: GetTurnInput,
): Promise<TurnRecord<TurnCustom> | undefined> {
  return atomic.readGroup(trx => assembleTurnRecord(trx, input));
}

/**
 * listTurns — ORDER BY created_at, turn_id; LIMIT limit+1 OFFSET offset.
 * Returns turn rows only (no snapshot assembly); use getTurn for full TurnRecord.
 */
export async function listTurns(db: Kysely<Database>, input: ListTurnsInput): Promise<ListTurnsResult> {
  const rows = await db
    .selectFrom('turn')
    .select([
      'session_id',
      'turn_id',
      'first_turn_id',
      'previous_turn_id',
      jsonText<string[]>(sql.ref('ancestor_ids')).as('ancestor_ids'),
      jsonText<TurnInputItem[]>(sql.ref('input')).as('input'),
      jsonText<TurnState>(sql.ref('state')).as('state'),
      jsonText<Record<string, unknown> | null>(sql.ref('custom')).as('custom'),
      'created_at',
      'updated_at',
    ])
    .where('session_id', '=', input.session_id)
    .orderBy('created_at', 'asc')
    .orderBy('turn_id', 'asc')
    .limit(input.limit + 1)
    .offset(input.offset)
    .execute();

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;

  const turns: TurnRecordWithoutSnapshot<TurnCustom>[] = page.map(row => ({
    turn_id: row.turn_id,
    session_id: row.session_id,
    first_turn_id: row.first_turn_id,
    ancestor_ids: row.ancestor_ids,
    previous_turn_id: row.previous_turn_id,
    state: row.state,
    input: row.input,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    custom: parseTurnCustom(row.custom),
  }));

  return {
    turns,
    next_offset: hasMore ? input.offset + input.limit : null,
  };
}

/**
 * updateTurnState — first terminal write wins: the running → terminal flip, its turn.done
 * event, and the session metrics fold commit together. Missing → NotFound, terminal → Conflict.
 */
export async function updateTurnState(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  input: UpdateTurnStateInput,
): Promise<void> {
  const keys: TurnKeys = { session_id: input.session_id, turn_id: input.turn_id };
  const current = await loadTurnForTransition(db, keys);
  if (!current) {
    throw new TurnNotFoundError(input.turn_id);
  }
  if (current.state.status !== 'running') {
    throw new TurnNotRunningError(input.turn_id, terminalTurnState(current.state, input.turn_id));
  }

  const [eventInsert] = await atomic.batchWrite({
    executor: db,
    queries: terminalTransitionQueries(db, {
      keys,
      state: input.state,
      turn_created_at: current.created_at,
      turn_done_event: input.turn_done_event,
    }),
  });
  if ((eventInsert?.changes ?? 0) === 0) {
    await classifyTurnFenceWriteFailure(db, keys);
  }
}
