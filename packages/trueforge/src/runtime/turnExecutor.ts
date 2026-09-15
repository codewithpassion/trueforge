import {
  SessionStoreNotFoundError,
  TurnNotFoundError,
  type CancellationReason,
  type SessionHandle,
  type Turn,
  type TurnInputItem,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { AgentHarnessError, McpConnectionError } from '@truefoundry/trueforge-core/core/errors';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { IAgentStore } from '../db/agentStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { ISkillStore } from '../db/skillStore';
import type { SequencedEvent } from './event-subscription';

/** Error classes do not survive a Durable Object RPC boundary, so executors report failures as data. */
export interface TurnExecutorFailure {
  ok: false;
  status: ContentfulStatusCode;
  code: string;
  message: string;
}

export type TurnStartResult = { ok: true; turn: Turn } | TurnExecutorFailure;

export type TurnEventsResult =
  { ok: true; events: AsyncGenerator<SequencedEvent<TurnStreamingEvent>, void, unknown> } | TurnExecutorFailure;

export type TurnCancelResult = { ok: true } | TurnExecutorFailure;

/** Stores already resolved for the caller, so token-bound stores stay bound to that caller. */
export interface TurnStores {
  agentStore: IAgentStore;
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerWithAuthStore;
  sandboxProviderStore: ISandboxProviderStore;
  skillStore: Pick<ISkillStore, 'resolveTurnSkills'>;
}

export interface TurnStartInput {
  session: SessionHandle;
  input: TurnInputItem[] | undefined;
  previous_turn_id: string | undefined;
  userRef: string;
  stores: TurnStores;
}

/**
 * Where turns run. Domain failures come back as {@link TurnExecutorFailure}; unexpected errors still
 * throw so the app error handler logs them and answers 500.
 */
export interface TurnExecutor {
  /** Resolves once the first event is on the resumable stream, so an immediate subscribe cannot 412. */
  start(input: TurnStartInput): Promise<TurnStartResult>;
  /** Starts a turn and yields its sequenced events until the turn ends. */
  startStreaming(input: TurnStartInput): Promise<TurnEventsResult>;
  /** Replays events after `after_sequence_number`, then follows the live stream until `signal` aborts. */
  subscribe(input: {
    tenant_id: string;
    session_id: string;
    turn_id: string;
    after_sequence_number: number | undefined;
    signal: AbortSignal;
  }): Promise<TurnEventsResult>;
  /** Aborts the turn where it runs, or freezes it when nothing is running it. */
  cancel(input: {
    session: Pick<SessionHandle, 'session_id' | 'tenant_id' | 'freezeTurn'>;
    turn_id: string;
    reason: CancellationReason;
  }): Promise<TurnCancelResult>;
}

const HTTP_EXCEPTION_CODES = {
  400: 'bad_request',
  404: 'not_found',
  422: 'unprocessable_entity',
} as const;

/** Client-caused turn-start failures; undefined means the error is unexpected and must be rethrown. */
export function turnStartFailure(error: unknown): TurnExecutorFailure | undefined {
  if (error instanceof HTTPException) {
    if (error.status === 400 || error.status === 404 || error.status === 422) {
      return { ok: false, status: error.status, code: HTTP_EXCEPTION_CODES[error.status], message: error.message };
    }
    return undefined;
  }
  if (error instanceof SessionStoreNotFoundError) {
    return { ok: false, status: 404, code: 'not_found', message: error.message };
  }
  if (error instanceof AgentHarnessError && !(error instanceof McpConnectionError)) {
    switch (error.code) {
      case 'invalid_file_input':
        return { ok: false, status: 400, code: error.code, message: error.message };
      case 'invalid_send_input':
      case 'agent_sandbox_required':
      case 'tool_name_collision':
        return { ok: false, status: 422, code: error.code, message: error.message };
      case 'capability_state_error':
      case 'mcp_connection_failed':
        return undefined;
    }
  }
  return undefined;
}

/** Freeze a running turn; missing turns are a no-op (already gone). */
export async function freezeTurnIgnoringMissing(
  session: Pick<SessionHandle, 'freezeTurn'>,
  input: { turnId: string; reason: CancellationReason },
): Promise<void> {
  try {
    await session.freezeTurn({ turn_id: input.turnId, reason: input.reason });
  } catch (error) {
    if (error instanceof TurnNotFoundError) {
      return;
    }
    throw error;
  }
}
