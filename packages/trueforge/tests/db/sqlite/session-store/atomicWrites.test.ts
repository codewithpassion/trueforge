import { MAIN_THREAD_ID } from '@truefoundry/trueforge-core/agent-session/models/TurnRecord';
import {
  PreviousTurnRunningError,
  SessionNotFoundError,
  TurnNotRunningError,
} from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import { getEmptyCurrentContextUsage } from '@truefoundry/trueforge-core/core/runtime/contextUsage';
import { sql } from 'kysely';

import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTurnDoneEvent,
} from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { BetterSqliteAtomicRunner } from '../../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { Database } from '../../../../src/db/sqlite/types';
import { InterleavingAtomicRunner } from '../interleavingAtomicRunner';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const TENANT = 't1';
const SESSION = 's1';
const TURN_SCOPED_TABLES = [
  'turn',
  'turn_thread',
  'turn_thread_context',
  'thread_context_log',
  'thread_capability_state',
  'session_event',
] as const;

describe('SqliteSessionStore conditional-chain writes', () => {
  let env: SqliteTestDatabase;
  let runner: InterleavingAtomicRunner<Database>;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    runner = new InterleavingAtomicRunner(new BetterSqliteAtomicRunner(env.db));
    store = new SqliteSessionStore(env.db, runner);
    await store.createSession({
      tenant_id: TENANT,
      session_id: SESSION,
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  async function rowCounts(turnId: string): Promise<Record<string, number | undefined>> {
    const counts: Record<string, number | undefined> = {};
    for (const table of TURN_SCOPED_TABLES) {
      const result = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE turn_id = ${turnId}
      `.execute(env.db);
      counts[table] = result.rows[0]?.n;
    }
    return counts;
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
});
