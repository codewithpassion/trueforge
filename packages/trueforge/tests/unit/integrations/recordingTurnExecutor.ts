import { makeCreateTurnInput } from '../../../../trueforge-core/tests/agent-session/testHelpers';
import type { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type {
  TurnExecutor,
  TurnExecutorFailure,
  TurnStartInput,
  TurnStartResult,
} from '../../../src/runtime/turnExecutor';
import { toWireTurn } from '../../../src/runtime/turnRunner';
import { newId } from '../../../src/utils/id';

/**
 * Records every start and persists a real running turn, so the outbox row written
 * against the returned id points at a turn that exists. Nothing is executed.
 */
export class RecordingTurnExecutor implements TurnExecutor {
  readonly starts: TurnStartInput[] = [];
  readonly #sessionStore: SqliteSessionStore;
  #nextFailure: TurnExecutorFailure | undefined;

  constructor(sessionStore: SqliteSessionStore) {
    this.#sessionStore = sessionStore;
  }

  /** The next `start` reports this failure instead of persisting a turn. */
  failNextStart(failure: TurnExecutorFailure): void {
    this.#nextFailure = failure;
  }

  async start(input: TurnStartInput): Promise<TurnStartResult> {
    this.starts.push(input);
    const failure = this.#nextFailure;
    if (failure !== undefined) {
      this.#nextFailure = undefined;
      return failure;
    }
    const turnId = newId();
    await this.#sessionStore.createTurn(
      makeCreateTurnInput({ sessionId: input.session.session_id, turnId, previousTurnId: null }),
    );
    const turn = await this.#sessionStore.getTurn({ session_id: input.session.session_id, turn_id: turnId });
    if (turn === undefined) {
      throw new Error(`turn was not stored: ${turnId}`);
    }
    return { ok: true, turn: toWireTurn(turn) };
  }

  startStreaming(): never {
    throw new Error('integration turns are never streamed');
  }

  subscribe(): never {
    throw new Error('not used');
  }

  cancel(): never {
    throw new Error('not used');
  }
}
