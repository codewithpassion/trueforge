/**
 * What a paused turn is waiting for, reduced to something a channel can put in a message.
 *
 * A turn pauses with `required_actions` that name tool call ids only; the call's name and
 * arguments live on the `model.message` event those refs point at, so that one event is read
 * back here and nowhere else.
 */
import type { TerminalTurnState, TurnHandle } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import { z } from 'zod';

/** The tool an agent asks a question with; its answer resumes the turn as a tool response. */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

/**
 * How far back the model message that requested the pending calls is looked for. It is the
 * last thing the turn did before pausing, so one page is generous.
 */
export const PENDING_ACTION_EVENT_SCAN = 50;

/** Argument keys whose value is never shown; matching is on the key, so the value is never read. */
const SECRET_ARGUMENT_KEY =
  /(token|secret|password|passphrase|credential|api[-_]?key|apikey|auth|cookie|private[-_]?key|session[-_]?id)/i;
const REDACTED = '[redacted]';
/** Longest one argument value may be before it is cut. */
const ARGUMENT_VALUE_MAX = 120;
/** Longest the whole summary may be; Block Kit text is capped far above this. */
const ARGUMENT_SUMMARY_MAX = 600;

/** One tool call held back until a human decides. */
export interface PendingToolApproval {
  /** Thread that owns the call; the resume input must name it. */
  thread_id: string;
  tool_call_id: string;
  tool_name: string;
  /** Redacted and truncated, so it is safe to post into a channel. */
  argument_summary: string;
}

/** A question the agent asked through `ask_user_question`. */
export interface PendingQuestion {
  thread_id: string;
  tool_call_id: string;
  question: string;
  options: readonly string[];
}

/**
 * Approvals win when a turn pauses on both, because a denied call usually changes what the
 * question would have been.
 */
export type PendingAction =
  { type: 'approval'; approvals: readonly PendingToolApproval[] } | { type: 'question'; question: PendingQuestion };

const AskUserQuestionArgumentsSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).default([]),
});

interface ResolvedToolCall {
  name: string;
  /** JSON-encoded, exactly as the model produced it. */
  argumentsJson: string;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function scalarSummary(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(value, ARGUMENT_VALUE_MAX);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  return truncate(JSON.stringify(value), ARGUMENT_VALUE_MAX);
}

/**
 * A one-line, human-readable form of the call's arguments. Values under a key that reads like
 * a credential are dropped rather than shortened, because a prefix of a secret is still one.
 */
export function summarizeToolArguments(argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    // A model that emitted something other than JSON still deserves a readable line.
    return truncate(argumentsJson.trim(), ARGUMENT_SUMMARY_MAX);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return truncate(scalarSummary(parsed), ARGUMENT_SUMMARY_MAX);
  }
  const parts = Object.entries(parsed).map(
    ([key, value]) => `${key}: ${SECRET_ARGUMENT_KEY.test(key) ? REDACTED : scalarSummary(value)}`,
  );
  return truncate(parts.join(', '), ARGUMENT_SUMMARY_MAX);
}

/** Indexes the tool calls of every `model.message` in the scanned page by tool call id. */
async function readToolCalls(turn: Pick<TurnHandle, 'listEvents'>): Promise<Map<string, ResolvedToolCall>> {
  const { data } = await turn.listEvents({ limit: PENDING_ACTION_EVENT_SCAN, order: 'desc' });
  const calls = new Map<string, ResolvedToolCall>();
  for (const event of data) {
    if (event.type !== EventType.MODEL_MESSAGE) {
      continue;
    }
    for (const call of event.tool_calls ?? []) {
      // Descending order means the newest copy of an id is seen first and must win.
      if (!calls.has(call.id)) {
        calls.set(call.id, { name: call.function.name, argumentsJson: call.function.arguments });
      }
    }
  }
  return calls;
}

function questionFrom(input: {
  thread_id: string;
  tool_call_id: string;
  call: ResolvedToolCall;
}): PendingQuestion | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.call.argumentsJson);
  } catch {
    return undefined;
  }
  const asked = AskUserQuestionArgumentsSchema.safeParse(parsed);
  if (!asked.success) {
    return undefined;
  }
  return {
    thread_id: input.thread_id,
    tool_call_id: input.tool_call_id,
    question: asked.data.question,
    options: asked.data.options,
  };
}

/**
 * What the turn is waiting for, or undefined when it is waiting for nothing a channel can
 * offer — an MCP authorization, or a client tool this layer does not answer.
 */
export async function readPendingAction(input: {
  turn: Pick<TurnHandle, 'listEvents'>;
  state: TerminalTurnState;
}): Promise<PendingAction | undefined> {
  const { state } = input;
  if (state.status !== 'done' || state.required_actions.length === 0) {
    return undefined;
  }
  const calls = await readToolCalls(input.turn);

  const approvals: PendingToolApproval[] = [];
  for (const action of state.required_actions) {
    if (action.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      continue;
    }
    for (const ref of action.tool_calls) {
      const call = calls.get(ref.id);
      if (call === undefined) {
        continue;
      }
      approvals.push({
        thread_id: action.thread_id,
        tool_call_id: ref.id,
        tool_name: call.name,
        argument_summary: summarizeToolArguments(call.argumentsJson),
      });
    }
  }
  if (approvals.length > 0) {
    return { type: 'approval', approvals };
  }

  for (const action of state.required_actions) {
    if (action.type !== EventType.TOOL_RESPONSE_REQUIRED) {
      continue;
    }
    for (const ref of action.tool_calls) {
      const call = calls.get(ref.id);
      if (call?.name !== ASK_USER_QUESTION_TOOL) {
        continue;
      }
      const question = questionFrom({ thread_id: action.thread_id, tool_call_id: ref.id, call });
      if (question !== undefined) {
        return { type: 'question', question };
      }
    }
  }
  return undefined;
}
