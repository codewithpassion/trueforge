import {
  AgentSpecSchema,
  CancellationReason,
  Sessions,
  type SessionHandle,
  type TerminalTurnState,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { EventType, newEventId } from '@truefoundry/trueforge-core/core/events/schema';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import {
  makeCreateTurnInput,
  makeDoneTurnState,
  makeModelMessageEvent,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { REQUEST_HUMAN_TAKEOVER_TOOL } from '../../../src/computers/requestHumanTakeover';
import type { ComputerRelayPort, ComputersService } from '../../../src/computers/service';
import { TurnDesktopLeases } from '../../../src/computers/turnDesktopLeases';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { Database } from '../../../src/db/sqlite/types';
import { ASK_USER_QUESTION_TOOL } from '../../../src/integrations/pendingActions';
import { createTurnDrainedHook } from '../../../src/runtime/turnDrainedHook';
import type { TurnStores } from '../../../src/runtime/turnExecutor';
import { ScriptedTurnSessions } from '../apis/scriptedSessions';
import { testNodeTurnExecutor } from './testNodeTurnExecutor';

const TENANT = 'default';
const SESSION_ID = 's1';
const TURN_ID = 'turn-1';
const COMPUTER_ID = 'cmp_1';
const silent = createLogger({ silent: true });

interface Harness {
  db: Kysely<Database>;
  sessionStore: SqliteSessionStore;
  stores: TurnStores;
}

/** A session whose one turn used `sandboxId`, or never made a sandbox when it is null. */
async function createHarness(sandboxId: string | null): Promise<Harness> {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const atomic = new BetterSqliteAtomicRunner(db);
  const sessionStore = new SqliteSessionStore(db, atomic);
  await sessionStore.createSession({
    tenant_id: TENANT,
    session_id: SESSION_ID,
    created_by_subject: { subject_id: 'u1', subject_type: 'user', subject_display_name: 'U1' },
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }) },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await sessionStore.createTurn(makeCreateTurnInput({ sessionId: SESSION_ID, turnId: TURN_ID }));
  if (sandboxId !== null) {
    await sessionStore.patchSandboxInfo({
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      sandbox_info: { sandbox_id: sandboxId },
    });
  }
  return {
    db,
    sessionStore,
    stores: {
      agentStore: new SqliteAgentStore(db),
      modelProviderStore: new SqliteModelProviderStore(db),
      mcpServerStore: new McpServerWithAuthStore({
        store: new SqliteMcpServerStore(db, atomic),
        tokenStore: new SqliteOAuthTokenStore(db),
        clientName: 'trueforge-tests',
      }),
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
      skillStore: new SqliteSkillStore(db),
    },
  };
}

async function sessionHandle(harness: Harness): Promise<SessionHandle> {
  const session = await new Sessions({ sessionStore: harness.sessionStore }).get({
    tenant_id: TENANT,
    session_id: SESSION_ID,
  });
  if (session === undefined) {
    throw new Error('session was not created');
  }
  return session;
}

/** Relays that record which computer was asked to release, or note a takeover of, which turn. */
function recordingComputers(): {
  computers: Pick<ComputersService, 'relay'>;
  released: string[];
  pointers: string[];
} {
  const released: string[] = [];
  const pointers: string[] = [];
  const relay = (computerId: string): ComputerRelayPort => ({
    request: () => Promise.reject(new Error('not used')),
    releaseLease: ({ tenant_id, session_id, turn_id }) => {
      released.push(`${computerId}:${tenant_id}:${session_id}:${turn_id}`);
      return Promise.resolve({ released: true });
    },
    recordTakeoverPointer: ({ tenant_id, session_id, turn_id }) => {
      pointers.push(`${computerId}:${tenant_id}:${session_id}:${turn_id}`);
      return Promise.resolve({ recorded: true });
    },
    clearTakeoverPointer: () => Promise.reject(new Error('not used')),
    listTakeoverPointers: () => Promise.reject(new Error('not used')),
    takeHumanLease: () => Promise.reject(new Error('not used')),
    releaseHumanLease: () => Promise.reject(new Error('not used')),
    revoke: () => Promise.reject(new Error('not used')),
    disconnect: () => Promise.reject(new Error('not used')),
    destroy: () => Promise.reject(new Error('not used')),
    status: () => Promise.reject(new Error('not used')),
  });
  return { computers: { relay }, released, pointers };
}

const REMOTE_SANDBOX_ID = `v1:remote-computer:${COMPUTER_ID}/${SESSION_ID}`;
const RELEASED = `${COMPUTER_ID}:${TENANT}:${SESSION_ID}:${TURN_ID}`;

/** A ledger in which this turn sent a desktop op to COMPUTER_ID. */
function leasedDuringTurn(): TurnDesktopLeases {
  const leases = new TurnDesktopLeases();
  leases.record({ turn_id: TURN_ID, computer_id: COMPUTER_ID });
  return leases;
}

describe('the turn drained hook', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.db.destroy();
    harness = undefined;
  });

  it('delivers, then releases the desktop lease this turn took', async () => {
    harness = await createHarness(REMOTE_SANDBOX_ID);
    const { computers, released } = recordingComputers();
    const order: string[] = [];
    const hook = createTurnDrainedHook({
      deliver: () => {
        order.push('deliver');
        return Promise.resolve();
      },
      desktop: { computers, leases: leasedDuringTurn(), agentStore: harness.stores.agentStore },
      logger: silent,
    });

    await hook({ session: await sessionHandle(harness), turn_id: TURN_ID });

    expect(order).toEqual(['deliver']);
    expect(released).toEqual([RELEASED]);
  });

  it('releases a lease taken by a turn that ended before it recorded any sandbox', async () => {
    // A turn cancelled or failed mid-op has no sandbox_info; the lease the relay gave it is still there.
    harness = await createHarness(null);
    const { computers, released } = recordingComputers();
    const hook = createTurnDrainedHook({
      deliver: () => Promise.resolve(),
      desktop: { computers, leases: leasedDuringTurn(), agentStore: harness.stores.agentStore },
      logger: silent,
    });

    await hook({ session: await sessionHandle(harness), turn_id: TURN_ID });

    expect(released).toEqual([RELEASED]);
  });

  it('asks no relay when the turn sent no desktop op, whatever sandbox it used', async () => {
    harness = await createHarness(REMOTE_SANDBOX_ID);
    const { computers, released } = recordingComputers();
    const leases = new TurnDesktopLeases();
    leases.record({ turn_id: 'another-turn', computer_id: COMPUTER_ID });
    const hook = createTurnDrainedHook({
      deliver: () => Promise.resolve(),
      desktop: { computers, leases, agentStore: harness.stores.agentStore },
      logger: silent,
    });

    await hook({ session: await sessionHandle(harness), turn_id: TURN_ID });

    expect(released).toEqual([]);
  });

  it('still releases the lease when delivery fails', async () => {
    harness = await createHarness(REMOTE_SANDBOX_ID);
    const { computers, released } = recordingComputers();
    const hook = createTurnDrainedHook({
      deliver: () => Promise.reject(new Error('slack is down')),
      desktop: { computers, leases: leasedDuringTurn(), agentStore: harness.stores.agentStore },
      logger: silent,
    });

    await expect(hook({ session: await sessionHandle(harness), turn_id: TURN_ID })).resolves.toBeUndefined();
    expect(released).toEqual([RELEASED]);
  });
});

const AGENT_TURN_ID = 'turn-agent';

/** How the takeover-harness turn ended. */
type TurnEnd = 'takeover' | 'question' | 'cancelled' | 'error';

/**
 * A session of a saved agent on COMPUTER_ID whose one turn called `tool_name` and then ended as
 * `end`. Only `takeover` and `question` finish holding the call.
 */
async function takeoverHarness(input: {
  end: TurnEnd;
  session_id: string;
  computer_id: string | undefined;
  db?: Kysely<Database>;
}): Promise<{ db: Kysely<Database>; session: SessionHandle; agentStore: SqliteAgentStore }> {
  const db = input.db ?? createSqliteDb(':memory:');
  if (input.db === undefined) {
    await migrateSqliteToLatest(db);
  }
  const sessionStore = new SqliteSessionStore(db, new BetterSqliteAtomicRunner(db));
  const agentStore = new SqliteAgentStore(db);
  const subject = { subject_id: 'u1', subject_type: 'user' as const, subject_display_name: 'U1' };
  const agent = await agentStore.createAgent({
    tenant_id: TENANT,
    name: `desk-${input.session_id}`,
    description: '',
    manifest: AgentSpecSchema.parse({
      model: { name: 'test-provider/test-model' },
      config: {
        sandbox:
          input.computer_id === undefined
            ? { enabled: false }
            : { enabled: true, computer_id: input.computer_id, desktop: true },
      },
    }),
    external_id: null,
    created_by_subject: subject,
  });
  await sessionStore.createSession({
    tenant_id: TENANT,
    session_id: input.session_id,
    created_by_subject: subject,
    agent: { type: 'reference', id: agent.id, name: agent.name },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await sessionStore.createTurn(makeCreateTurnInput({ sessionId: input.session_id, turnId: AGENT_TURN_ID }));
  const toolName = input.end === 'question' ? ASK_USER_QUESTION_TOOL : REQUEST_HUMAN_TAKEOVER_TOOL;
  const args = input.end === 'question' ? { question: 'Which?' } : { reason: 'Log into the portal' };
  const modelEventId = newEventId();
  await sessionStore.appendToEvents({
    session_id: input.session_id,
    turn_id: AGENT_TURN_ID,
    events: [
      {
        type: EventType.MODEL_MESSAGE,
        id: modelEventId,
        created_at: new Date().toISOString(),
        thread_id: 'main',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: toolName, arguments: JSON.stringify(args) },
            tool_info: { type: 'truefoundry-system', name: toolName },
          },
        ],
      },
    ],
  });
  const completedAt = new Date().toISOString();
  const state: TerminalTurnState =
    input.end === 'cancelled'
      ? { status: 'cancelled', reason: CancellationReason.ClientCancelled, completed_at: completedAt }
      : input.end === 'error'
        ? { status: 'error', message: 'model failed', completed_at: completedAt }
        : {
            status: 'done',
            output: null,
            required_actions: [
              {
                type: EventType.TOOL_RESPONSE_REQUIRED,
                id: newEventId(),
                created_at: completedAt,
                thread_id: 'main',
                tool_calls: [{ id: 'call-1', source_event_id: modelEventId }],
              },
            ],
            completed_at: completedAt,
          };
  await sessionStore.updateTurnState({
    session_id: input.session_id,
    turn_id: AGENT_TURN_ID,
    state,
    turn_done_event: makeTurnDoneEvent(state),
  });
  const session = await new Sessions({ sessionStore }).get({ tenant_id: TENANT, session_id: input.session_id });
  if (session === undefined) {
    throw new Error('session was not created');
  }
  return { db, session, agentStore };
}

describe('the turn drained hook and takeover requests', () => {
  let db: Kysely<Database> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  async function drain(input: { end: TurnEnd; computer_id?: string | undefined }): Promise<string[]> {
    const built = await takeoverHarness({
      end: input.end,
      session_id: SESSION_ID,
      computer_id: 'computer_id' in input ? input.computer_id : COMPUTER_ID,
    });
    db = built.db;
    const { computers, pointers } = recordingComputers();
    const hook = createTurnDrainedHook({
      deliver: () => Promise.resolve(),
      desktop: { computers, leases: new TurnDesktopLeases(), agentStore: built.agentStore },
      logger: silent,
    });
    await hook({ session: built.session, turn_id: AGENT_TURN_ID });
    return pointers;
  }

  it('records a pointer on the agent’s computer when the turn ends asking for a takeover', async () => {
    expect(await drain({ end: 'takeover' })).toEqual([`${COMPUTER_ID}:${TENANT}:${SESSION_ID}:${AGENT_TURN_ID}`]);
  });

  it.each<TurnEnd>(['cancelled', 'error'])('records none when the turn was %s', async end => {
    expect(await drain({ end })).toEqual([]);
  });

  it('records none when the turn waits on a question instead', async () => {
    expect(await drain({ end: 'question' })).toEqual([]);
  });

  it('records none when the agent no longer runs on a computer', async () => {
    expect(await drain({ end: 'takeover', computer_id: undefined })).toEqual([]);
  });

  it('records each waiting session on its own', async () => {
    const first = await takeoverHarness({ end: 'takeover', session_id: 's-a', computer_id: COMPUTER_ID });
    db = first.db;
    const second = await takeoverHarness({
      end: 'takeover',
      session_id: 's-b',
      computer_id: COMPUTER_ID,
      db: first.db,
    });
    const { computers, pointers } = recordingComputers();
    const hook = createTurnDrainedHook({
      deliver: () => Promise.resolve(),
      desktop: { computers, leases: new TurnDesktopLeases(), agentStore: first.agentStore },
      logger: silent,
    });

    await hook({ session: first.session, turn_id: AGENT_TURN_ID });
    await hook({ session: second.session, turn_id: AGENT_TURN_ID });

    expect(pointers).toEqual([
      `${COMPUTER_ID}:${TENANT}:s-a:${AGENT_TURN_ID}`,
      `${COMPUTER_ID}:${TENANT}:s-b:${AGENT_TURN_ID}`,
    ]);
  });
});

describe('NodeTurnExecutor.startStreaming', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.db.destroy();
    harness = undefined;
  });

  function scripted(current: Harness): ScriptedTurnSessions {
    return new ScriptedTurnSessions({
      sessionStore: current.sessionStore,
      turn_id: TURN_ID,
      events: async function* (): AsyncGenerator<TurnStreamingEvent> {
        yield makeModelMessageEvent();
        const state = makeDoneTurnState();
        await current.sessionStore.updateTurnState({
          session_id: SESSION_ID,
          turn_id: TURN_ID,
          state,
          turn_done_event: makeTurnDoneEvent(state),
        });
      },
    });
  }

  async function startStreaming(input: { current: Harness; signal: AbortSignal }) {
    const recording = recordingComputers();
    const executor = testNodeTurnExecutor({
      sandboxIntegration: undefined,
      onTurnDrained: createTurnDrainedHook({
        deliver: () => Promise.resolve(),
        desktop: {
          computers: recording.computers,
          leases: leasedDuringTurn(),
          agentStore: input.current.stores.agentStore,
        },
        logger: silent,
      }),
    });
    const session = await scripted(input.current).get({ tenant_id: TENANT, session_id: SESSION_ID });
    if (session === undefined) {
      throw new Error('session was not created');
    }
    const result = await executor.startStreaming({
      session,
      input: [{ type: 'user.message', content: 'hi' }],
      previous_turn_id: undefined,
      userRef: 'u1',
      request_metadata: undefined,
      stores: input.current.stores,
      signal: input.signal,
    });
    return { result, released: recording.released };
  }

  it('runs the drained hook once the streamed turn ends, releasing the lease', async () => {
    harness = await createHarness(REMOTE_SANDBOX_ID);
    const { result, released } = await startStreaming({ current: harness, signal: new AbortController().signal });
    if (!result.ok) {
      throw new Error(`startStreaming failed: ${result.message}`);
    }
    for await (const event of result.events) {
      void event;
    }

    expect(released).toEqual([RELEASED]);
  });

  it('still runs it when the client has gone away', async () => {
    harness = await createHarness(REMOTE_SANDBOX_ID);
    const client = new AbortController();
    client.abort();
    const { result, released } = await startStreaming({ current: harness, signal: client.signal });
    expect(result.ok).toBe(true);

    for (let attempt = 0; attempt < 100 && released.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(released).toEqual([RELEASED]);
  });
});
