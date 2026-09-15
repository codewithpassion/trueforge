import { Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { startTurnInProcess, turnStreamId } from '../../src/runtime/turnRunner';
import { createConsoleLogger } from '../../src/workers/logger';
import { D1_TURN_STATEMENT_WARNING } from '../../src/workers/SessionDO';
import { createMockSession, d1Persistence, migrateDatabase, TENANT_ID, USER_REF } from './harness';

/** Runs one turn of K datetime tool calls against D1 and counts the statements it sends. */
async function measureTurn(toolCalls: number) {
  const sessionId = `budget-${String(toolCalls)}`;
  await createMockSession({ sessionId, scenario: `tools-${String(toolCalls)}` });
  let statements = 0;
  const persistence = d1Persistence(count => {
    statements += count;
  });
  const session = await new Sessions({ sessionStore: persistence.sessionStore }).get({
    tenant_id: TENANT_ID,
    session_id: sessionId,
  });
  if (session === undefined) {
    throw new Error('session was not created');
  }
  const eventSubscriptions = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
  const turnId = `turn-${sessionId}`;
  const { drained } = await startTurnInProcess({
    session,
    turn_id: turnId,
    input: [{ type: 'user.message', content: 'Call the datetime tool until told to stop.' }],
    previous_turn_id: undefined,
    userRef: USER_REF,
    deps: {
      agentStore: persistence.agentStore,
      modelProviderStore: persistence.modelProviderStore,
      mcpServerStore: persistence.mcpServerStore,
      sandboxProviderStore: persistence.sandboxProviderStore,
      skillStore: persistence.skillStore,
      activeTurns: new ActiveTurnRegistry(),
      eventSubscriptions,
      logger: createConsoleLogger({ level: 'error', bindings: {} }),
      sandboxIntegration: undefined,
    },
  });
  await drained;

  const turn = await persistence.sessionStore.getTurn({ session_id: sessionId, turn_id: turnId });
  const { data: persistedEvents } = await persistence.sessionStore.listTurnEvents({
    session_id: sessionId,
    turn_id: turnId,
    limit: 1000,
    page_token: undefined,
    order: 'asc',
  });
  let streamedEvents = 0;
  const abort = new AbortController();
  const replay = eventSubscriptions.get(turnStreamId(TENANT_ID, sessionId, turnId)).poll(0, { signal: abort.signal });
  for await (const event of replay) {
    streamedEvents = event.sequence_number;
    if (event.type === 'turn.done') {
      break;
    }
  }
  abort.abort();
  return { turn, statements, persistedEvents: persistedEvents.length, streamedEvents };
}

beforeAll(async () => {
  await migrateDatabase();
});

describe('D1 statements per turn', () => {
  // 99 tool calls need 100 model calls, the most one turn allows; 100 tool calls end at that limit.
  it.each([10, 50, 99, 100])('measures a turn with %i tool iterations', async toolCalls => {
    const measured = await measureTurn(toolCalls);

    console.info(
      JSON.stringify({
        toolCalls,
        statements: measured.statements,
        persistedEvents: measured.persistedEvents,
        streamedEvents: measured.streamedEvents,
        statementsPerPersistedEvent: Number((measured.statements / measured.persistedEvents).toFixed(2)),
        statementsPerToolCall: Number((measured.statements / toolCalls).toFixed(2)),
        crossesWarning: measured.statements > D1_TURN_STATEMENT_WARNING,
        state: measured.turn?.state,
      }),
    );
    if (toolCalls < 100) {
      expect(measured.turn?.state.status).toBe('done');
    } else {
      expect(measured.turn?.state).toMatchObject({
        status: 'error',
        message: expect.stringMatching(/iteration limit/),
      });
    }
    expect(measured.statements).toBeGreaterThan(toolCalls);
  });
});
