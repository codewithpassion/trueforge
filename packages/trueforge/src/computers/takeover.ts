import type { SessionHandle, Sessions } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core/util/errorLogFields';
import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IComputerStore } from '../db/computerStore';
import { readPendingAction, type PendingTakeoverRequest } from '../integrations/pendingActions';
import { WRITE_OUTCOME_UNKNOWN_CODE, type TurnExecutor, type TurnStores } from '../runtime/turnExecutor';
import { newId } from '../utils/id';
import { takeoverToolResponseText } from './requestHumanTakeover';
import type { ComputerRelayPort, ComputersService, TakeoverPointer } from './service';

export interface PendingTakeover {
  session_id: string;
  turn_id: string;
  tool_call_id: string;
  reason: string;
  requested_at: string;
  agent_id: string;
}

export interface HumanTakeoverService {
  /** Reads RemoteComputerDO pointers, drops stale ones lazily, and resolves payload from turn state. */
  listPendingTakeovers(input: {
    tenant_id: string;
    computer_id: string;
    agent_id?: string;
  }): Promise<PendingTakeover[]>;
  /** Resumes the session server-side with the tool response; audit row computer.desktop.hand_back / cancel. */
  resolveTakeover(input: {
    tenant_id: string;
    computer_id: string;
    session_id: string;
    outcome: 'completed' | 'cancelled';
    note: string | null;
    acting_user_id: string;
  }): Promise<TakeoverResolution>;
}

/**
 * `resume_failed` drops the request from the desktop; the session itself is left waiting.
 * `outcome_unknown` keeps it listed: the resume may have landed, and the next listing drops it if so.
 */
export type TakeoverResolution =
  | { ok: true }
  | { ok: false; code: 'not_pending' | 'takeover_already_answered' | 'outcome_unknown' }
  | { ok: false; code: 'resume_failed'; message: string };

export interface HumanTakeoverServiceDeps {
  computers: Pick<ComputersService, 'relay'> & { store: Pick<IComputerStore, 'getComputer' | 'appendAudit'> };
  sessions: Pick<Sessions, 'get'>;
  agentStore: Pick<IAgentStore, 'getAgent'>;
  turnExecutor: Pick<TurnExecutor, 'start'>;
  /** Stores for a turn that runs as the session's creator, the way a scheduled run does. */
  resolveTurnStores: (input: { session: SessionHandle; agent: AgentRecord }) => TurnStores;
  logger: Logger;
}

/**
 * What a pointer points at now. `answered` means the session moved past the turn, or is running
 * past it, so someone else already answered; `gone` means there is nothing left to answer.
 */
type Inspected =
  | {
      kind: 'pending';
      session: SessionHandle;
      agent_id: string;
      takeover: PendingTakeoverRequest;
      requested_at: string;
    }
  | { kind: 'answered' }
  | { kind: 'gone' }
  | { kind: 'other_agent' };

/**
 * Who took the desktop, handed it back or cancelled a takeover is kept here only: turns carry no
 * actor. Best-effort, so a failed write never undoes the change it describes.
 */
export async function recordDesktopControl(input: {
  store: Pick<IComputerStore, 'getComputer' | 'appendAudit'>;
  logger: Logger;
  tenant_id: string;
  computer_id: string;
  session_id: string | null;
  turn_id: string | null;
  action: 'take_control' | 'hand_back' | 'cancel';
  acting_user_id: string;
}): Promise<void> {
  try {
    const computer = await input.store.getComputer({ tenant_id: input.tenant_id, computer_id: input.computer_id });
    await input.store.appendAudit({
      id: newId(),
      computer_id: input.computer_id,
      computer_name: computer?.name ?? input.computer_id,
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      turn_id: input.turn_id,
      op: 'desktop',
      command: `computer.desktop.${input.action} by ${input.acting_user_id}`,
      exit_code: null,
      outcome: 'ok',
      duration_ms: 0,
      bytes_out: 0,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    input.logger.warn('Could not record a desktop control change', {
      ...extractErrorLogFields(error),
      computer_id: input.computer_id,
      action: input.action,
    });
  }
}

/** Takeover requests live in turn state; the relay only remembers which sessions to look at. */
export function createHumanTakeoverService(deps: HumanTakeoverServiceDeps): HumanTakeoverService {
  async function inspect({
    relay,
    tenant_id,
    pointer,
    agent_id: onlyAgentId,
  }: {
    relay: ComputerRelayPort;
    tenant_id: string;
    pointer: TakeoverPointer;
    agent_id: string | undefined;
  }): Promise<Inspected> {
    const drop = async (kind: 'answered' | 'gone'): Promise<Inspected> => {
      await relay.clearTakeoverPointer({ tenant_id, ...pointer });
      return { kind };
    };
    const session = await deps.sessions.get({ tenant_id, session_id: pointer.session_id });
    if (session?.agent.type !== 'reference') {
      return drop('gone');
    }
    if (onlyAgentId !== undefined && session.agent.id !== onlyAgentId) {
      return { kind: 'other_agent' };
    }
    if (session.record.last_turn_id !== pointer.turn_id) {
      return drop('answered');
    }
    const turn = await session.getTurn(pointer.turn_id);
    const state = turn?.state;
    if (turn === undefined || state === undefined) {
      return drop('gone');
    }
    if (state.status === 'running') {
      return { kind: 'answered' };
    }
    const pending = state.status === 'done' ? await readPendingAction({ turn, state }) : undefined;
    if (state.status !== 'done' || pending?.type !== 'takeover') {
      return drop('gone');
    }
    return {
      kind: 'pending',
      session,
      agent_id: session.agent.id,
      takeover: pending.takeover,
      requested_at: state.completed_at,
    };
  }

  return {
    async listPendingTakeovers({ tenant_id, computer_id, agent_id }) {
      const relay = deps.computers.relay(computer_id);
      const pointers = await relay.listTakeoverPointers({ tenant_id });
      const inspected = await Promise.all(
        pointers.map(async pointer => ({ pointer, found: await inspect({ relay, tenant_id, pointer, agent_id }) })),
      );
      return inspected.flatMap(({ pointer, found }) =>
        found.kind === 'pending'
          ? [
              {
                session_id: pointer.session_id,
                turn_id: pointer.turn_id,
                tool_call_id: found.takeover.tool_call_id,
                reason: found.takeover.reason,
                requested_at: found.requested_at,
                agent_id: found.agent_id,
              },
            ]
          : [],
      );
    },

    async resolveTakeover({ tenant_id, computer_id, session_id, outcome, note, acting_user_id }) {
      const relay = deps.computers.relay(computer_id);
      const pointer = (await relay.listTakeoverPointers({ tenant_id })).find(
        candidate => candidate.session_id === session_id,
      );
      if (pointer === undefined) {
        return { ok: false, code: 'not_pending' };
      }
      const found = await inspect({ relay, tenant_id, pointer, agent_id: undefined });
      if (found.kind === 'answered') {
        return { ok: false, code: 'takeover_already_answered' };
      }
      if (found.kind !== 'pending') {
        return { ok: false, code: 'not_pending' };
      }
      const { session, takeover } = found;
      // A resume that cannot start now will not start on a retry either, so the request leaves the
      // desktop rather than staying listed; the creator can still answer it in chat.
      const resumeFailed = async (reason: string): Promise<TakeoverResolution> => {
        deps.logger.warn('Could not resume a session after a desktop takeover', {
          session_id,
          computer_id,
          reason,
        });
        await relay.clearTakeoverPointer({ tenant_id, ...pointer });
        return {
          ok: false,
          code: 'resume_failed',
          message: `The session could not continue (${reason}). It is no longer listed here; the person who started it can still answer it in the chat.`,
        };
      };
      const agent = await deps.agentStore.getAgent({ tenant_id, id: found.agent_id });
      if (agent === undefined) {
        return resumeFailed(`agent not found: ${found.agent_id}`);
      }
      const creator = session.record.created_by_subject.subject_id;

      // `'auto'` rather than the pending turn's id: only a resume of the tip is checked against a
      // racing answer, and an explicit id would fork the session instead of losing to it.
      const started = await deps.turnExecutor.start({
        session,
        input: [
          {
            type: EventType.USER_TOOL_RESPONSE,
            thread_id: takeover.thread_id,
            tool_call_id: takeover.tool_call_id,
            content: takeoverToolResponseText({
              outcome,
              note,
              answered_by: acting_user_id === creator ? 'session_creator' : 'another_user',
            }),
          },
        ],
        previous_turn_id: 'auto',
        // The turn runs as the session's creator; who answered goes to the audit row.
        userRef: creator,
        request_metadata: undefined,
        stores: deps.resolveTurnStores({ session, agent }),
      });
      if (!started.ok) {
        // 409: another answer landed, or is running, between the check above and this resume.
        if (started.status === 409) {
          return { ok: false, code: 'takeover_already_answered' };
        }
        // The resume may have committed. The pointer stays: if it did, the session tip moved and
        // the next listing drops the pointer; if not, the request can be answered again.
        if (started.code === WRITE_OUTCOME_UNKNOWN_CODE) {
          deps.logger.warn('A desktop takeover resume may or may not have started', {
            session_id,
            computer_id,
            reason: started.message,
          });
          return { ok: false, code: 'outcome_unknown' };
        }
        return resumeFailed(started.message);
      }

      await relay.clearTakeoverPointer({ tenant_id, ...pointer });
      await recordDesktopControl({
        store: deps.computers.store,
        logger: deps.logger,
        tenant_id,
        computer_id,
        session_id,
        turn_id: pointer.turn_id,
        action: outcome === 'completed' ? 'hand_back' : 'cancel',
        acting_user_id,
      });
      return { ok: true };
    },
  };
}
