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

/** Terminal turns never return to running, so no statement in a fenced batch can flip this. */
export function turnRunning(keys: TurnKeys): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM turn WHERE session_id = ${keys.session_id} AND turn_id = ${keys.turn_id} AND state->>'status' = 'running')`;
}

/** D1 caps a single bound value; stay well under it measured in UTF-8 bytes. */
export const MAX_BOUND_JSON_BYTES = 1024 * 1024;

const utf8 = new TextEncoder();

/**
 * Splits rows so each `JSON.stringify(chunk)` stays within `maxBytes`, preserving order.
 * A row larger than the cap is its own chunk; it is never split.
 * Known limit: a single row over D1's 2,000,000-byte value cap cannot be bound on D1.
 */
export function chunkJsonRows<T>(rows: readonly T[], maxBytes: number = MAX_BOUND_JSON_BYTES): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  // Brackets, plus one comma per row after the first.
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = utf8.encode(JSON.stringify(row)).byteLength;
    const addedBytes = current.length === 0 ? rowBytes : rowBytes + 1;
    if (current.length > 0 && currentBytes + addedBytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    currentBytes += current.length === 0 ? rowBytes : rowBytes + 1;
    current.push(row);
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** One chunk of rows bound as a JSON array; see `chunkJsonRows`. */
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

export function insertTurnThreadsQueries(
  db: Kysely<Database>,
  args: { keys: TurnKeys; rows: readonly TurnThreadRow[]; guard: RawBuilder<boolean>; updated_at: string },
): CompiledQuery[] {
  const { keys, guard, updated_at } = args;
  return chunkJsonRows(args.rows).map(rows =>
    db
      .insertInto('turn_thread')
      .columns([
        'session_id',
        'turn_id',
        'thread_id',
        'checkpoint',
        'agent_info',
        'current_context_usage',
        'updated_at',
      ])
      .expression(
        sql`SELECT ${keys.session_id}, ${keys.turn_id}, ${rowText('thread_id')}, ${rowJsonb('checkpoint')},
            ${rowNullableJsonb('agent_info')}, ${rowJsonb('current_context_usage')}, ${updated_at}
          FROM ${jsonRowSource(rows)}
          WHERE ${guard}`,
      )
      .compile(),
  );
}

export interface CapabilityStateRow {
  thread_id: string;
  key: string;
  state: JsonValue | null;
}

export function insertCapabilityStatesQueries(
  db: Kysely<Database>,
  args: { keys: TurnKeys; rows: readonly CapabilityStateRow[]; guard: RawBuilder<boolean>; updated_at: string },
): CompiledQuery[] {
  const { keys, guard, updated_at } = args;
  return chunkJsonRows(args.rows).map(rows =>
    db
      .insertInto('thread_capability_state')
      .columns(['session_id', 'turn_id', 'thread_id', 'key', 'state', 'updated_at'])
      .expression(
        sql`SELECT ${keys.session_id}, ${keys.turn_id}, ${rowText('thread_id')}, ${rowText('key')},
            ${rowNullableJsonb('state')}, ${updated_at}
          FROM ${jsonRowSource(rows)}
          WHERE ${guard}`,
      )
      .compile(),
  );
}

export interface ContextAppendRow {
  thread_id: string;
  body: ContextMessage;
}

/**
 * Per chunk: log rows, then their `turn_thread_context` mapping. AUTOINCREMENT ids cannot be
 * read back inside a batch, so the mapping takes the newest `chunk.length` log rows (a batch
 * runs alone) and numbers them after the thread's current max `pos`, which already includes
 * earlier chunks, so positions stay contiguous and in input order.
 */
export function appendContextQueries(
  db: Kysely<Database>,
  args: { keys: TurnKeys; rows: readonly ContextAppendRow[]; guard: RawBuilder<boolean>; created_at: string },
): CompiledQuery[] {
  const { keys, guard, created_at } = args;
  return chunkJsonRows(args.rows).flatMap(rows => [
    db
      .insertInto('thread_context_log')
      .columns(['session_id', 'thread_id', 'turn_id', 'body', 'created_at'])
      .expression(
        sql`SELECT ${keys.session_id}, ${rowText('thread_id')}, ${keys.turn_id}, ${rowJsonb('body')}, ${created_at}
          FROM ${jsonRowSource(rows)}
          WHERE ${guard}
          ORDER BY j.key`,
      )
      .compile(),
    db
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
      .compile(),
  ]);
}
