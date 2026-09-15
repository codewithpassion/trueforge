import {
  AgentSpecSchema,
  SessionHandle,
  Sessions,
  TurnHandle,
  type GetSessionInput,
  type ISessionStore,
  type SessionRecord,
  type TurnRecord,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { makeCreateTurnInput } from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';

type TurnEvents = () => AsyncGenerator<TurnStreamingEvent>;

class ScriptedTurnHandle extends TurnHandle {
  readonly #events: TurnEvents;

  constructor(input: { store: ISessionStore; turn: TurnRecord; events: TurnEvents }) {
    super({ store: input.store, turn: input.turn });
    this.#events = input.events;
  }

  override stream(): AsyncGenerator<TurnStreamingEvent> {
    return this.#events();
  }
}

class ScriptedSessionHandle extends SessionHandle {
  readonly #createTurn: () => Promise<TurnHandle>;

  constructor(input: { store: ISessionStore; session: SessionRecord; createTurn: () => Promise<TurnHandle> }) {
    super({ store: input.store, session: input.session });
    this.#createTurn = input.createTurn;
  }

  override createTurn(): Promise<TurnHandle> {
    return this.#createTurn();
  }
}

/** Sessions from a real store whose `createTurn` returns the stored turn `turn_id`, streaming `events` instead of running the agent. */
export class ScriptedTurnSessions extends Sessions {
  readonly #store: ISessionStore;
  readonly #turnId: string;
  readonly #events: TurnEvents;

  constructor(input: { sessionStore: ISessionStore; turn_id: string; events: TurnEvents }) {
    super({ sessionStore: input.sessionStore });
    this.#store = input.sessionStore;
    this.#turnId = input.turn_id;
    this.#events = input.events;
  }

  override async get(input: GetSessionInput): Promise<SessionHandle | undefined> {
    const session = await this.#store.getSession(input);
    if (session === undefined) {
      return undefined;
    }
    return new ScriptedSessionHandle({
      store: this.#store,
      session,
      createTurn: async () => {
        const turn = await this.#store.getTurn({ session_id: session.session_id, turn_id: this.#turnId });
        if (turn === undefined) {
          throw new Error(`Scripted turn is not stored: ${this.#turnId}`);
        }
        return new ScriptedTurnHandle({ store: this.#store, turn, events: this.#events });
      },
    });
  }
}

/** Session `s1`, owned by the standalone caller, with a running turn `turn_id`; returns the stored turn. */
export async function seedStandaloneSessionTurn(input: {
  sessionStore: ISessionStore;
  turn_id: string;
}): Promise<TurnRecord> {
  const { sessionStore, turn_id: turnId } = input;
  await sessionStore.createSession({
    tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
    session_id: 's1',
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }) },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await sessionStore.createTurn(makeCreateTurnInput({ sessionId: 's1', turnId }));
  const turn = await sessionStore.getTurn({ session_id: 's1', turn_id: turnId });
  if (turn === undefined) {
    throw new Error(`Seeded turn is not stored: ${turnId}`);
  }
  return turn;
}
