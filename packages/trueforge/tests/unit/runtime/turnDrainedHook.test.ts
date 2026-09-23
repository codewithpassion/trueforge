import {
  AgentSpecSchema,
  Sessions,
  type SessionHandle,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import { createLogger } from 'winston';
import {
  makeCreateTurnInput,
  makeDoneTurnState,
  makeModelMessageEvent,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
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

/** Relays that record which computer was asked to release which turn of which session. */
function recordingComputers(): { computers: Pick<ComputersService, 'relay'>; released: string[] } {
  const released: string[] = [];
  const relay = (computerId: string): ComputerRelayPort => ({
    request: () => Promise.reject(new Error('not used')),
    releaseLease: ({ tenant_id, session_id, turn_id }) => {
      released.push(`${computerId}:${tenant_id}:${session_id}:${turn_id}`);
      return Promise.resolve({ released: true });
    },
    revoke: () => Promise.reject(new Error('not used')),
    disconnect: () => Promise.reject(new Error('not used')),
    destroy: () => Promise.reject(new Error('not used')),
    status: () => Promise.reject(new Error('not used')),
  });
  return { computers: { relay }, released };
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
      desktop: { computers, leases: leasedDuringTurn() },
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
      desktop: { computers, leases: leasedDuringTurn() },
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
      desktop: { computers, leases },
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
      desktop: { computers, leases: leasedDuringTurn() },
      logger: silent,
    });

    await expect(hook({ session: await sessionHandle(harness), turn_id: TURN_ID })).resolves.toBeUndefined();
    expect(released).toEqual([RELEASED]);
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
        desktop: { computers: recording.computers, leases: leasedDuringTurn() },
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
