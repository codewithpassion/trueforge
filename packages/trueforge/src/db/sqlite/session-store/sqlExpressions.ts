/**
 * Session-store-only SQL fragments for conditional-chain batches.
 * Shared JSON/time helpers live in `../sqlExpressions`.
 */
import type { JsonValue } from '@truefoundry/trueforge-core/core/capabilities/AgentCapability';
import type { AgentInfo } from '@truefoundry/trueforge-core/core/events/schema';
import type { ContextMessage } from '@truefoundry/trueforge-core/core/runtime/AgentThread.types';
import type { CurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import type { Database, TurnThreadCheckpoint } from '../types';

export interface TurnKeys {
  session_id: string;
  turn_id: string;
}

/** Chain predicate for statements that follow the statement inserting this turn. */
export function turnExists(keys: TurnKeys): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM turn WHERE session_id = ${keys.session_id} AND turn_id = ${keys.turn_id})`;
}

/** Terminal turns never return to running, so no statement in a fenced batch can flip this. */
export function turnRunning(keys: TurnKeys): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM turn WHERE session_id = ${keys.session_id} AND turn_id = ${keys.turn_id} AND state->>'status' = 'running')`;
}

/** Rows bound once as a JSON array, so a set-based INSERT is one statement for any row count. */
export function jsonRowSource(rows: readonly unknown[]): RawBuilder<unknown> {
  return sql`json_each(${JSON.stringify(rows)}) AS j`;
}

export function rowText(field: string): RawBuilder<string> {
  return sql<string>`j.value ->> ${`$.${field}`}`;
}

export function rowJsonb(field: string): RawBuilder<string> {
  return sql<string>`jsonb(j.value -> ${`$.${field}`})`;
}

/** JSON null becomes SQL NULL, matching `value !== null ? jsonbBind(value) : null`. */
export function rowNullableJsonb(field: string): RawBuilder<string | null> {
  return sql<string | null>`jsonb(NULLIF(j.value -> ${`$.${field}`}, 'null'))`;
}

export interface TurnThreadRow {
  thread_id: string;
  checkpoint: TurnThreadCheckpoint;
  agent_info: AgentInfo | null;
  current_context_usage: CurrentContextUsage;
}

export function insertTurnThreadsQuery(
  db: Kysely<Database>,
  args: { keys: TurnKeys; rows: readonly TurnThreadRow[]; guard: RawBuilder<boolean>; updated_at: string },
): CompiledQuery {
  const { keys, rows, guard, updated_at } = args;
  return db
    .insertInto('turn_thread')
    .columns(['session_id', 'turn_id', 'thread_id', 'checkpoint', 'agent_info', 'current_context_usage', 'updated_at'])
    .expression(
      sql`SELECT ${keys.session_id}, ${keys.turn_id}, ${rowText('thread_id')}, ${rowJsonb('checkpoint')},
          ${rowNullableJsonb('agent_info')}, ${rowJsonb('current_context_usage')}, ${updated_at}
        FROM ${jsonRowSource(rows)}
        WHERE ${guard}`,
    )
    .compile();
}

export interface CapabilityStateRow {
  thread_id: string;
  key: string;
  state: JsonValue | null;
}

export function insertCapabilityStatesQuery(
  db: Kysely<Database>,
  args: { keys: TurnKeys; rows: readonly CapabilityStateRow[]; guard: RawBuilder<boolean>; updated_at: string },
): CompiledQuery {
  const { keys, rows, guard, updated_at } = args;
  return db
    .insertInto('thread_capability_state')
    .columns(['session_id', 'turn_id', 'thread_id', 'key', 'state', 'updated_at'])
    .expression(
      sql`SELECT ${keys.session_id}, ${keys.turn_id}, ${rowText('thread_id')}, ${rowText('key')},
          ${rowNullableJsonb('state')}, ${updated_at}
        FROM ${jsonRowSource(rows)}
        WHERE ${guard}`,
    )
    .compile();
}

export interface ContextAppendRow {
  thread_id: string;
  body: ContextMessage;
}

/**
 * Log rows, then their `turn_thread_context` mapping. AUTOINCREMENT ids cannot be read back
 * inside a batch, so the mapping takes the newest `rows.length` log rows (a batch runs alone)
 * and numbers them after the thread's current max `pos` in the target turn.
 */
export function appendContextQueries(
  db: Kysely<Database>,
  args: { keys: TurnKeys; rows: readonly ContextAppendRow[]; guard: RawBuilder<boolean>; created_at: string },
): CompiledQuery[] {
  const { keys, rows, guard, created_at } = args;
  if (rows.length === 0) {
    return [];
  }
  const insertLog = db
    .insertInto('thread_context_log')
    .columns(['session_id', 'thread_id', 'turn_id', 'body', 'created_at'])
    .expression(
      sql`SELECT ${keys.session_id}, ${rowText('thread_id')}, ${keys.turn_id}, ${rowJsonb('body')}, ${created_at}
        FROM ${jsonRowSource(rows)}
        WHERE ${guard}
        ORDER BY j.key`,
    )
    .compile();
  const insertMapping = db
    .insertInto('turn_thread_context')
    .columns(['session_id', 'turn_id', 'thread_id', 'pos', 'append_id'])
    .expression(
      sql`SELECT l.session_id, l.turn_id, l.thread_id,
          COALESCE((
            SELECT MAX(c.pos) FROM turn_thread_context AS c
            WHERE c.session_id = l.session_id AND c.turn_id = l.turn_id AND c.thread_id = l.thread_id
          ), 0) + ROW_NUMBER() OVER (PARTITION BY l.thread_id ORDER BY l.append_id),
          l.append_id
        FROM (
          SELECT session_id, turn_id, thread_id, append_id FROM thread_context_log
          ORDER BY append_id DESC LIMIT ${rows.length}
        ) AS l
        WHERE l.session_id = ${keys.session_id} AND l.turn_id = ${keys.turn_id} AND ${guard}`,
    )
    .compile();
  return [insertLog, insertMapping];
}
