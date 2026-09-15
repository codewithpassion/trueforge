import type {
  AddThreadsInput,
  AppendToThreadContextInput,
  OverwriteThreadContextInput,
  PatchMCPServersInput,
  PatchSandboxInfoInput,
  RemoveThreadsInput,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import type {
  ContextMessage,
  SubAgentCompletionMarker,
} from '@truefoundry/trueforge-core/core/runtime/AgentThread.types';
import type { CurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import type { AtomicRunner } from '../../atomic';
import { jsonbBind, jsonbSet, nowIso } from '../../sqlExpressions';
import type { Database } from '../../types';
import {
  appendContextQueries,
  insertCapabilityStatesQuery,
  insertTurnThreadsQuery,
  turnRunning,
  type CapabilityStateRow,
  type ContextAppendRow,
  type TurnKeys,
  type TurnThreadRow,
} from '../sqlExpressions';
import { assertTurnRunning, classifyTurnFenceWriteFailure, classifyTurnThreadWriteFailure } from './turns';

/**
 * addThreads — fenced batch: turn_thread rows (decisive), log + mapping rows, capability rows,
 * each conditional on the turn still running.
 */
export async function addThreads(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  input: AddThreadsInput,
): Promise<void> {
  const keys: TurnKeys = { session_id: input.session_id, turn_id: input.turn_id };
  if (input.threads.length === 0) {
    await assertTurnRunning(db, keys);
    return;
  }

  const now = nowIso();
  const guard = turnRunning(keys);
  const threadRows: TurnThreadRow[] = [];
  const appendRows: ContextAppendRow[] = [];
  const capabilityRows: CapabilityStateRow[] = [];

  for (const thread of input.threads) {
    threadRows.push({
      thread_id: thread.thread_id,
      checkpoint: { parent: thread.parent ?? null, completion: thread.completion ?? null },
      agent_info: thread.agent_info ?? null,
      current_context_usage: thread.current_context_usage,
    });

    for (const body of thread.context) {
      appendRows.push({ thread_id: thread.thread_id, body });
    }

    const capabilityState = thread.capability_state;
    if (capabilityState != null) {
      for (const key of Object.keys(capabilityState)) {
        const state = capabilityState[key];
        if (state === undefined) {
          throw new Error(
            `capability_state['${key}'] for thread '${thread.thread_id}' is undefined — undefined is banned from capability state`,
          );
        }
        capabilityRows.push({ thread_id: thread.thread_id, key, state });
      }
    }
  }

  const queries: CompiledQuery[] = [
    insertTurnThreadsQuery(db, { keys, rows: threadRows, guard, updated_at: now }),
    ...appendContextQueries(db, { keys, rows: appendRows, guard, created_at: now }),
  ];
  if (capabilityRows.length > 0) {
    queries.push(insertCapabilityStatesQuery(db, { keys, rows: capabilityRows, guard, updated_at: now }));
  }

  const [threadInsert] = await atomic.batchWrite({ executor: db, queries });
  if ((threadInsert?.changes ?? 0) === 0) {
    await classifyTurnFenceWriteFailure(db, keys);
  }
}

/**
 * removeThreads — fenced batch: DELETE this turn's turn_thread rows,
 * turn_thread_context rows, and capability rows.
 * Older turns keep their per-turn maps. Log rows stay (other turns may reference them).
 * Empty thread_ids is a no-op.
 */
export async function removeThreads(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  input: RemoveThreadsInput,
): Promise<void> {
  if (input.thread_ids.length === 0) {
    return;
  }

  const keys: TurnKeys = { session_id: input.session_id, turn_id: input.turn_id };
  const guard = turnRunning(keys);
  const [threadDelete] = await atomic.batchWrite({
    executor: db,
    queries: [
      db
        .deleteFrom('turn_thread')
        .where('session_id', '=', keys.session_id)
        .where('turn_id', '=', keys.turn_id)
        .where('thread_id', 'in', input.thread_ids)
        .where(guard)
        .compile(),
      db
        .deleteFrom('turn_thread_context')
        .where('session_id', '=', keys.session_id)
        .where('turn_id', '=', keys.turn_id)
        .where('thread_id', 'in', input.thread_ids)
        .where(guard)
        .compile(),
      db
        .deleteFrom('thread_capability_state')
        .where('session_id', '=', keys.session_id)
        .where('turn_id', '=', keys.turn_id)
        .where('thread_id', 'in', input.thread_ids)
        .where(guard)
        .compile(),
    ],
  });
  // Unknown thread ids delete nothing on a running turn; only a non-running turn is an error.
  if ((threadDelete?.changes ?? 0) === 0) {
    await assertTurnRunning(db, keys);
  }
}

function completionPatchExpr(completion: SubAgentCompletionMarker | null): RawBuilder<string> {
  if (completion === null) {
    return sql`checkpoint`;
  }
  return jsonbSet(sql.ref('checkpoint'), '$.completion', completion);
}

function usageSetExpr(usage: CurrentContextUsage | null): RawBuilder<string> {
  if (usage === null) {
    return sql`current_context_usage`;
  }
  return sql`coalesce(${jsonbBind(usage)}, current_context_usage)`;
}

async function fencedTurnThreadContextUpdate(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  args: {
    keys: TurnKeys;
    thread_id: string;
    context: ContextMessage[];
    replace_array: boolean;
    current_context_usage: CurrentContextUsage | null;
    completion: SubAgentCompletionMarker | null;
    /** When replace_array, usage is set unconditionally (overwrite contract). */
    usage_unconditional: CurrentContextUsage | null;
  },
): Promise<void> {
  const { keys, thread_id, context, replace_array } = args;
  const now = nowIso();

  const usageExpr =
    args.usage_unconditional !== null ? jsonbBind(args.usage_unconditional) : usageSetExpr(args.current_context_usage);

  // The thread UPDATE is decisive; the rest require the same "running turn + thread row" state,
  // which no statement in this batch changes.
  const guard = sql<boolean>`${turnRunning(keys)} AND EXISTS (
    SELECT 1 FROM turn_thread
    WHERE session_id = ${keys.session_id} AND turn_id = ${keys.turn_id} AND thread_id = ${thread_id}
  )`;
  const queries: CompiledQuery[] = [
    db
      .updateTable('turn_thread')
      .set({
        checkpoint: completionPatchExpr(args.completion),
        current_context_usage: usageExpr,
        updated_at: now,
      })
      .where('session_id', '=', keys.session_id)
      .where('turn_id', '=', keys.turn_id)
      .where('thread_id', '=', thread_id)
      .where(turnRunning(keys))
      .compile(),
  ];

  if (replace_array) {
    queries.push(
      db
        .deleteFrom('turn_thread_context')
        .where('session_id', '=', keys.session_id)
        .where('turn_id', '=', keys.turn_id)
        .where('thread_id', '=', thread_id)
        .where(guard)
        .compile(),
    );
  }

  queries.push(
    ...appendContextQueries(db, {
      keys,
      rows: context.map(body => ({ thread_id, body })),
      guard,
      created_at: now,
    }),
  );

  const [threadUpdate] = await atomic.batchWrite({ executor: db, queries });
  if ((threadUpdate?.changes ?? 0) === 0) {
    await classifyTurnThreadWriteFailure(db, keys, thread_id);
  }
}

/**
 * appendToThreadContext — fenced batch: inserts log rows, appends mapping rows,
 * updates usage (COALESCE: provided wins, else keep), patches completion.
 */
export async function appendToThreadContext(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  input: AppendToThreadContextInput,
): Promise<void> {
  await fencedTurnThreadContextUpdate(db, atomic, {
    keys: {
      session_id: input.session_id,
      turn_id: input.turn_id,
    },
    thread_id: input.thread_id,
    context: input.context,
    replace_array: false,
    current_context_usage: input.current_context_usage,
    completion: input.completion,
    usage_unconditional: null,
  });
}

/**
 * overwriteThreadContext — same fenced shape; context mapping is REPLACED.
 * Old log rows stay — ancestor turns' context mapping may reference them.
 */
export async function overwriteThreadContext(
  db: Kysely<Database>,
  atomic: AtomicRunner<Database>,
  input: OverwriteThreadContextInput,
): Promise<void> {
  await fencedTurnThreadContextUpdate(db, atomic, {
    keys: {
      session_id: input.session_id,
      turn_id: input.turn_id,
    },
    thread_id: input.event.thread_id,
    context: input.event.context,
    replace_array: true,
    current_context_usage: null,
    completion: null,
    usage_unconditional: input.event.current_context_usage,
  });
}

/**
 * patchMCPServers — conditional UPDATE fenced on state->>'status'='running'.
 * Shallow merge by server id (Postgres `||`): patched ids replace wholesale.
 */
export async function patchMCPServers(db: Kysely<Database>, input: PatchMCPServersInput): Promise<void> {
  const serversById: Record<string, (typeof input.mcp_servers)[number]> = {};
  for (const server of input.mcp_servers) {
    serversById[server.id] = server;
  }

  const keys: TurnKeys = {
    session_id: input.session_id,
    turn_id: input.turn_id,
  };

  // jsonb_patch is RFC 7396 (deep); rebuild via json_each so each id's value is replaced.
  const patchJson = JSON.stringify(serversById);

  const result = await db
    .updateTable('turn')
    .set({
      checkpoint: sql<string>`jsonb_set(
        checkpoint,
        '$.mcp_servers',
        coalesce((
          SELECT jsonb_group_object(key, jsonb(value))
          FROM (
            SELECT key, value
            FROM json_each(
              CASE WHEN json_type(checkpoint, '$.mcp_servers') = 'object'
                   THEN json(jsonb_extract(checkpoint, '$.mcp_servers'))
                   ELSE '{}' END
            )
            WHERE key NOT IN (SELECT key FROM json_each(${patchJson}))
            UNION ALL
            SELECT key, value FROM json_each(${patchJson})
          )
        ), jsonb('{}'))
      )`,
      updated_at: nowIso(),
    })
    .where('session_id', '=', keys.session_id)
    .where('turn_id', '=', keys.turn_id)
    .where(sql<boolean>`state->>'status' = 'running'`)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    await classifyTurnFenceWriteFailure(db, keys);
  }
}

/**
 * patchSandboxInfo — LWW replace via jsonb_set on sandbox_info key.
 */
export async function patchSandboxInfo(db: Kysely<Database>, input: PatchSandboxInfoInput): Promise<void> {
  const keys: TurnKeys = {
    session_id: input.session_id,
    turn_id: input.turn_id,
  };

  const result = await db
    .updateTable('turn')
    .set({
      checkpoint: jsonbSet(sql.ref('checkpoint'), '$.sandbox_info', input.sandbox_info),
      updated_at: nowIso(),
    })
    .where('session_id', '=', keys.session_id)
    .where('turn_id', '=', keys.turn_id)
    .where(sql<boolean>`state->>'status' = 'running'`)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    await classifyTurnFenceWriteFailure(db, keys);
  }
}
