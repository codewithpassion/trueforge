/**
 * Conditional-chain batches of the SQLite-dialect session store, run against better-sqlite3 (Jest)
 * and D1 (vitest-pool-workers). A concurrent writer is simulated between a store's reads and its batch.
 */
import { MAIN_THREAD_ID } from '@truefoundry/trueforge-core/agent-session/models/TurnRecord';
import { EventType } from '@truefoundry/trueforge-core/agent-session/schemas/events';
import type { AddThreadsInput } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  PreviousTurnRunningError,
  SessionNotFoundError,
  TurnNotRunningError,
} from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import { newEventId } from '@truefoundry/trueforge-core/core/events/schema';
import { getEmptyUsage } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import type { ContextMessage } from '@truefoundry/trueforge-core/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import { sql, type Kysely } from 'kysely';

import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeModelMessageEvent,
  makeTurnDoneEvent,
} from '../../../trueforge-core/tests/agent-session/testHelpers';
import type { AtomicRunner } from '../../src/db/sqlite/atomic';
import { SqliteSessionStore } from '../../src/db/sqlite/session-store/SqliteSessionStore';
import { chunkJsonRows } from '../../src/db/sqlite/session-store/sqlExpressions';
import type { Database } from '../../src/db/sqlite/types';
import { InterleavingAtomicRunner } from './interleavingAtomicRunner';

const ATOMIC_WRITES_TENANT = 't1';
const ATOMIC_WRITES_SESSION = 's1';
const TURN_SCOPED_TABLES = [
  'turn',
  'turn_thread',
  'turn_thread_context',
  'thread_context_log',
  'thread_capability_state',
  'session_event',
] as const;

export async function turnRowCounts({
  db,
  turnId,
}: {
  db: Kysely<Database>;
  turnId: string;
}): Promise<Record<string, number | undefined>> {
  const counts: Record<string, number | undefined> = {};
  for (const table of TURN_SCOPED_TABLES) {
    const result = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE turn_id = ${turnId}
    `.execute(db);
    counts[table] = result.rows[0]?.n;
  }
  return counts;
}

export async function createAtomicWritesSession(store: SqliteSessionStore): Promise<void> {
  await store.createSession({
    tenant_id: ATOMIC_WRITES_TENANT,
    session_id: ATOMIC_WRITES_SESSION,
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
}

export function runSessionStoreAtomicWritesSuite(
  getHarness: () => { db: Kysely<Database>; atomic: AtomicRunner<Database> },
): void {
  const TENANT = ATOMIC_WRITES_TENANT;
  const SESSION = ATOMIC_WRITES_SESSION;
  let db: Kysely<Database>;
  let runner: InterleavingAtomicRunner<Database>;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    const harness = getHarness();
    db = harness.db;
    runner = new InterleavingAtomicRunner(harness.atomic);
    store = new SqliteSessionStore(db, runner);
    await createAtomicWritesSession(store);
  });

  function rowCounts(turnId: string): Promise<Record<string, number | undefined>> {
    return turnRowCounts({ db, turnId });
  }

  const noRows = Object.fromEntries(TURN_SCOPED_TABLES.map(table => [table, 0]));

  async function finishTurn(turnId: string): Promise<void> {
    const state = makeDoneTurnState();
    await store.updateTurnState({
      session_id: SESSION,
      turn_id: turnId,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }

  function childTurnInput(turnId: string, message: string) {
    return makeCreateTurnInput({
      sessionId: SESSION,
      turnId,
      previousTurnId: 'turn-1',
      firstTurnId: 'turn-1',
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          context: [{ role: 'user', content: message }],
          current_context_usage: getEmptyCurrentContextUsage(),
        },
      ],
      capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: { probe: message } }],
    });
  }

  async function seedFinishedTurn(): Promise<void> {
    await store.createTurn(
      makeCreateTurnInput({
        sessionId: SESSION,
        turnId: 'turn-1',
        new_context_appends: [
          {
            thread_id: MAIN_THREAD_ID,
            context: [{ role: 'user', content: 'shared' }],
            current_context_usage: getEmptyCurrentContextUsage(),
          },
        ],
      }),
    );
    await finishTurn('turn-1');
  }

  it('previous turn running again by the time the batch runs: PreviousTurnRunningError and no rows', async () => {
    await seedFinishedTurn();
    runner.beforeNextBatch(async executor => {
      await sql`UPDATE turn SET state = jsonb_set(state, '$.status', 'running') WHERE turn_id = 'turn-1'`.execute(
        executor,
      );
    });

    await expect(store.createTurn(childTurnInput('turn-2', 'late'))).rejects.toBeInstanceOf(PreviousTurnRunningError);

    expect(await rowCounts('turn-2')).toEqual(noRows);
    const session = await store.getSession({ tenant_id: TENANT, session_id: SESSION });
    expect(session?.last_turn_id).toBe('turn-1');
    expect(session?.metrics.total_turns).toBe(1);
  });

  it('session deleted by the time the batch runs: SessionNotFoundError and no rows', async () => {
    await seedFinishedTurn();
    runner.beforeNextBatch(async executor => {
      await sql`DELETE FROM session WHERE session_id = ${SESSION}`.execute(executor);
    });

    await expect(store.createTurn(childTurnInput('turn-2', 'late'))).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(await rowCounts('turn-2')).toEqual(noRows);
  });

  it('concurrent forks from one finished turn each write only their own rows', async () => {
    await seedFinishedTurn();

    await Promise.all([
      store.createTurn(childTurnInput('turn-a', 'a-only')),
      store.createTurn(childTurnInput('turn-b', 'b-only')),
    ]);

    for (const turnId of ['turn-a', 'turn-b']) {
      expect(await rowCounts(turnId)).toEqual({
        turn: 1,
        turn_thread: 1,
        // Carried 'shared' mapping plus the fork's own append.
        turn_thread_context: 2,
        thread_context_log: 1,
        thread_capability_state: 1,
        session_event: 0,
      });
    }
    const session = await store.getSession({ tenant_id: TENANT, session_id: SESSION });
    expect(session?.metrics.total_turns).toBe(3);
  });

  it('terminal write that lands after updateTurnState reads the turn: TurnNotRunningError, no event, no metrics fold', async () => {
    await store.createTurn(makeCreateTurnInput({ sessionId: SESSION, turnId: 'turn-1' }));
    runner.beforeNextBatch(async executor => {
      await sql`UPDATE turn SET state = jsonb_set(state, '$.status', 'error') WHERE turn_id = 'turn-1'`.execute(
        executor,
      );
    });

    const state = makeDoneTurnState();
    await expect(
      store.updateTurnState({
        session_id: SESSION,
        turn_id: 'turn-1',
        state,
        turn_done_event: makeTurnDoneEvent(state),
      }),
    ).rejects.toBeInstanceOf(TurnNotRunningError);

    expect((await rowCounts('turn-1'))['session_event']).toBe(0);
    const session = await store.getSession({ tenant_id: TENANT, session_id: SESSION });
    expect(session?.metrics.total_duration_ms).toBe(0);
  });

  async function contextPositions(turnId: string): Promise<number[]> {
    const result = await sql<{ pos: number }>`
      SELECT pos FROM turn_thread_context WHERE turn_id = ${turnId} AND thread_id = ${MAIN_THREAD_ID} ORDER BY pos
    `.execute(db);
    return result.rows.map(row => row.pos);
  }

  function contents(messages: readonly ContextMessage[]): string[] {
    return messages.map(message =>
      'role' in message && message.role === 'user' && typeof message.content === 'string' ? message.content : '',
    );
  }

  async function mainContext(turnId: string): Promise<string[]> {
    const turn = await store.getTurn({ session_id: SESSION, turn_id: turnId });
    return contents(turn?.snapshot.threads[MAIN_THREAD_ID]?.context ?? []);
  }

  // 300k two-byte characters: under the cap by string length, over it by UTF-8 bytes.
  function largeMessages(prefix: string, count: number): ContextMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      role: 'user',
      content: `${prefix}${String(i)}:${'é'.repeat(300_000)}`,
    }));
  }

  it('context rows crossing the bound-value cap are chunked with input order and contiguous positions', async () => {
    const created = largeMessages('c', 4);
    expect(chunkJsonRows(created.map(body => ({ thread_id: MAIN_THREAD_ID, body })))).toHaveLength(4);

    await store.createTurn(
      makeCreateTurnInput({
        sessionId: SESSION,
        turnId: 'turn-1',
        new_context_appends: [
          { thread_id: MAIN_THREAD_ID, context: created, current_context_usage: getEmptyCurrentContextUsage() },
        ],
      }),
    );
    const appended = largeMessages('a', 3);
    await store.appendToThreadContext({
      session_id: SESSION,
      turn_id: 'turn-1',
      thread_id: MAIN_THREAD_ID,
      context: appended,
      current_context_usage: null,
      completion: null,
    });

    expect(await mainContext('turn-1')).toEqual(contents([...created, ...appended]));
    expect(await contextPositions('turn-1')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('context overwrite across chunks numbers from 1 contiguously', async () => {
    await store.createTurn(
      makeCreateTurnInput({
        sessionId: SESSION,
        turnId: 'turn-1',
        new_context_appends: [
          {
            thread_id: MAIN_THREAD_ID,
            context: [{ role: 'user', content: 'old' }],
            current_context_usage: getEmptyCurrentContextUsage(),
          },
        ],
      }),
    );
    const replacement = largeMessages('r', 3);
    await store.overwriteThreadContext({
      session_id: SESSION,
      turn_id: 'turn-1',
      event: {
        type: EventType.AGENT_CONTEXT_OVERWRITE,
        id: newEventId(),
        created_at: new Date().toISOString(),
        thread_id: MAIN_THREAD_ID,
        reason: 'compaction',
        context: replacement,
        current_context_usage: getEmptyCurrentContextUsage(),
        usage: getEmptyUsage(),
      },
    });

    expect(await contextPositions('turn-1')).toEqual([1, 2, 3]);
    expect(await mainContext('turn-1')).toEqual(contents(replacement));
  });

  it('every batch statement stays within D1 per-statement limits for large inputs', async () => {
    const many = 300;
    await store.createTurn(
      makeCreateTurnInput({
        sessionId: SESSION,
        turnId: 'turn-1',
        new_context_appends: [
          {
            thread_id: MAIN_THREAD_ID,
            context: Array.from({ length: many }, (_, i) => ({ role: 'user', content: `m${String(i)}` })),
            current_context_usage: getEmptyCurrentContextUsage(),
          },
        ],
        capability_states: [
          {
            thread_id: MAIN_THREAD_ID,
            capability_state: Object.fromEntries(Array.from({ length: many }, (_, i) => [`k${String(i)}`, i])),
          },
        ],
      }),
    );
    const threadIds = Array.from({ length: many }, (_, i) => `child-${String(i)}`);
    await store.addThreads({
      session_id: SESSION,
      turn_id: 'turn-1',
      threads: threadIds.map(thread_id => ({
        thread_id,
        context: [{ role: 'user', content: thread_id }],
        current_context_usage: getEmptyCurrentContextUsage(),
        parent: { thread_id: MAIN_THREAD_ID, tool_call_id: thread_id },
        agent_info: { type: 'dynamic', name: thread_id, input: 'task' },
        completion: null,
        capability_state: { probe: thread_id },
      })),
    });
    await store.appendToEvents({
      session_id: SESSION,
      turn_id: 'turn-1',
      events: Array.from({ length: many }, () => makeModelMessageEvent()),
    });
    await store.removeThreads({ session_id: SESSION, turn_id: 'turn-1', thread_ids: threadIds });

    const counts = await rowCounts('turn-1');
    expect(counts['session_event']).toBe(many);
    expect(counts['turn_thread']).toBe(1);
    expect(runner.statements.length).toBeGreaterThan(0);
    for (const statement of runner.statements) {
      expect(statement.parameters.length).toBeLessThanOrEqual(100);
      expect(statement.sql.length).toBeLessThan(100_000);
    }
  });

  // 600 KB each: two rows never share a 1 MiB chunk, so N rows give N statements.
  function bigText(prefix: string): string {
    return `${prefix}:${'é'.repeat(300_000)}`;
  }

  function insertStatementsSince({ start, table }: { start: number; table: string }): number {
    return runner.statements.slice(start).filter(statement => statement.sql.startsWith(`insert into "${table}" (`))
      .length;
  }

  const childIds = ['child-0', 'child-1', 'child-2'];

  function largeThreads(): AddThreadsInput['threads'] {
    return childIds.map(thread_id => ({
      thread_id,
      context: largeMessages(`${thread_id}-`, 2),
      current_context_usage: getEmptyCurrentContextUsage(),
      parent: { thread_id: MAIN_THREAD_ID, tool_call_id: thread_id },
      agent_info: { type: 'dynamic', name: thread_id, input: bigText(thread_id) },
      completion: null,
      capability_state: { probe: bigText(thread_id) },
    }));
  }

  async function threadContextPositions(threadId: string): Promise<number[]> {
    const result = await sql<{ pos: number }>`
      SELECT pos FROM turn_thread_context WHERE turn_id = 'turn-1' AND thread_id = ${threadId} ORDER BY pos
    `.execute(db);
    return result.rows.map(row => row.pos);
  }

  it('addThreads with every row source over the cap writes all chunks in order', async () => {
    await store.createTurn(makeCreateTurnInput({ sessionId: SESSION, turnId: 'turn-1' }));
    const threads = largeThreads();
    const start = runner.statements.length;

    await store.addThreads({ session_id: SESSION, turn_id: 'turn-1', threads });

    expect(insertStatementsSince({ start, table: 'turn_thread' })).toBe(3);
    expect(insertStatementsSince({ start, table: 'thread_context_log' })).toBe(6);
    expect(insertStatementsSince({ start, table: 'turn_thread_context' })).toBe(6);
    expect(insertStatementsSince({ start, table: 'thread_capability_state' })).toBe(3);

    const turn = await store.getTurn({ session_id: SESSION, turn_id: 'turn-1' });
    for (const thread of threads) {
      const snapshot = turn?.snapshot.threads[thread.thread_id];
      expect(contents(snapshot?.context ?? [])).toEqual(contents(thread.context));
      expect(snapshot?.agent_info).toEqual(thread.agent_info);
      expect(snapshot?.capability_state).toEqual(thread.capability_state);
      expect(await threadContextPositions(thread.thread_id)).toEqual([1, 2]);
    }
  });

  it('addThreads over the cap on a turn that stopped running: TurnNotRunningError and no rows', async () => {
    await store.createTurn(makeCreateTurnInput({ sessionId: SESSION, turnId: 'turn-1' }));
    const before = await rowCounts('turn-1');
    runner.beforeNextBatch(async executor => {
      await sql`UPDATE turn SET state = jsonb_set(state, '$.status', 'error') WHERE turn_id = 'turn-1'`.execute(
        executor,
      );
    });
    const start = runner.statements.length;

    await expect(
      store.addThreads({ session_id: SESSION, turn_id: 'turn-1', threads: largeThreads() }),
    ).rejects.toBeInstanceOf(TurnNotRunningError);

    expect(insertStatementsSince({ start, table: 'turn_thread' })).toBe(3);
    expect(await rowCounts('turn-1')).toEqual(before);
  });

  function largeEvents() {
    return Array.from({ length: 3 }, (_, i) => ({ ...makeModelMessageEvent(), content: bigText(`e${String(i)}`) }));
  }

  async function storedEventIds(): Promise<string[]> {
    const result = await sql<{ event_id: string }>`
      SELECT event_id FROM session_event WHERE turn_id = 'turn-1' ORDER BY rowid
    `.execute(db);
    return result.rows.map(row => row.event_id);
  }

  it('appendToEvents over the cap writes one chunk per event in input order', async () => {
    await store.createTurn(makeCreateTurnInput({ sessionId: SESSION, turnId: 'turn-1' }));
    const events = largeEvents();
    const start = runner.statements.length;

    await store.appendToEvents({ session_id: SESSION, turn_id: 'turn-1', events });

    expect(insertStatementsSince({ start, table: 'session_event' })).toBe(3);
    expect(await storedEventIds()).toEqual(events.map(event => event.id));
  });

  it('appendToEvents over the cap on a turn that stopped running: TurnNotRunningError and no rows', async () => {
    await store.createTurn(makeCreateTurnInput({ sessionId: SESSION, turnId: 'turn-1' }));
    runner.beforeNextBatch(async executor => {
      await sql`UPDATE turn SET state = jsonb_set(state, '$.status', 'error') WHERE turn_id = 'turn-1'`.execute(
        executor,
      );
    });
    const start = runner.statements.length;

    await expect(
      store.appendToEvents({ session_id: SESSION, turn_id: 'turn-1', events: largeEvents() }),
    ).rejects.toBeInstanceOf(TurnNotRunningError);

    expect(insertStatementsSince({ start, table: 'session_event' })).toBe(3);
    expect(await storedEventIds()).toEqual([]);
  });
}
