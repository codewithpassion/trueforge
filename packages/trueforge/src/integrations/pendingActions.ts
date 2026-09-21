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
  /(token|secret|password|passphrase|credential|api[-_]?key|apikey|auth|cookie|private[-_]?key|session[-_]?id|signature|bearer)/i;
/** Values that look like a credential whatever they are called: `Bearer …`, `sk-…`, a JWT, a long opaque blob. */
const SECRET_VALUE = /^(bearer\s|basic\s|sk-|xox[abprs]-|ghp_|gh[pousr]_|eyJ[\w-]+\.[\w-]+\.)/i;
/** Long enough that nothing readable is this shape, and dense enough to be a key rather than prose. */
const OPAQUE_MIN_LENGTH = 24;
const REDACTED = '[redacted]';
/** Longest one argument value may be before it is cut. */
const ARGUMENT_VALUE_MAX = 120;
/** Longest the whole summary may be; Block Kit text is capped far above this. */
const ARGUMENT_SUMMARY_MAX = 600;
/** How deep the summary walks before it stops naming keys. */
const ARGUMENT_DEPTH_MAX = 4;

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
 * What one channel interaction can settle. Core refuses a resume that leaves any pending call
 * unresolved, so a set that cannot be decided in one go is not offered at all: it reads as
 * `undefined` here and the channel posts a status line instead.
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

/** A value with no spaces and enough length to be a key rather than a sentence. */
function looksOpaque(value: string): boolean {
  return value.length >= OPAQUE_MIN_LENGTH && !/\s/.test(value) && /[A-Za-z]/.test(value) && /[\d\-_.]/.test(value);
}

function secretValue(value: string): boolean {
  return SECRET_VALUE.test(value.trim()) || looksOpaque(value);
}

/** Depth-first, so a credential nested under a harmless key is redacted too. */
function summarizeValue(input: { value: unknown; depth: number }): string {
  const { value, depth } = input;
  if (typeof value === 'string') {
    return secretValue(value) ? REDACTED : truncate(value, ARGUMENT_VALUE_MAX);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  if (depth >= ARGUMENT_DEPTH_MAX) {
    // Deeper than this the keys stop being readable anyway, and stringifying would leak them.
    return '…';
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => summarizeValue({ value: entry, depth: depth + 1 })).join(', ')}]`;
  }
  if (typeof value === 'object') {
    return `{${summarizeEntries({ value, depth: depth + 1 })}}`;
  }
  return REDACTED;
}

function summarizeEntries(input: { value: object; depth: number }): string {
  return Object.entries(input.value)
    .map(
      ([key, entry]) =>
        `${key}: ${SECRET_ARGUMENT_KEY.test(key) ? REDACTED : summarizeValue({ value: entry, depth: input.depth })}`,
    )
    .join(', ');
}

/**
 * A one-line, human-readable form of the call's arguments. A value under a key that reads like
 * a credential is dropped rather than shortened, because a prefix of a secret is still one, and
 * so is a value that looks like a credential whatever it is called.
 *
 * Arguments that are not JSON are never shown: a model that produced something else could have
 * produced anything, and there are no keys to redact by.
 */
export function summarizeToolArguments(argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return `(${String(argumentsJson.length)} characters of non-JSON arguments, hidden)`;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return truncate(summarizeValue({ value: parsed, depth: 1 }), ARGUMENT_SUMMARY_MAX);
  }
  if (Array.isArray(parsed)) {
    return truncate(summarizeValue({ value: parsed, depth: 1 }), ARGUMENT_SUMMARY_MAX);
  }
  return truncate(summarizeEntries({ value: parsed, depth: 1 }), ARGUMENT_SUMMARY_MAX);
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

interface PendingRef {
  thread_id: string;
  tool_call_id: string;
}

function refsOf(input: {
  state: Extract<TerminalTurnState, { status: 'done' }>;
  type: typeof EventType.TOOL_APPROVAL_REQUIRED | typeof EventType.TOOL_RESPONSE_REQUIRED;
}): PendingRef[] {
  return input.state.required_actions.flatMap(action =>
    action.type === input.type
      ? action.tool_calls.map(ref => ({ thread_id: action.thread_id, tool_call_id: ref.id }))
      : [],
  );
}

/**
 * What the turn is waiting for, when one interaction can settle all of it.
 *
 * Undefined when it cannot: an MCP authorization, a client tool this layer does not answer, a
 * call whose model message is out of the scanned page, or a mix of approvals and questions —
 * core rejects a resume that leaves any pending call unresolved, so a half-answerable set must
 * not be offered buttons at all.
 */
export async function readPendingAction(input: {
  turn: Pick<TurnHandle, 'listEvents'>;
  state: TerminalTurnState;
}): Promise<PendingAction | undefined> {
  const { state } = input;
  if (state.status !== 'done' || state.required_actions.length === 0) {
    return undefined;
  }
  // Anything that is not one of these two cannot be settled from a channel at all.
  if (state.required_actions.some(action => action.type === EventType.MCP_AUTH_REQUIRED)) {
    return undefined;
  }
  const approvalRefs = refsOf({ state, type: EventType.TOOL_APPROVAL_REQUIRED });
  const clientRefs = refsOf({ state, type: EventType.TOOL_RESPONSE_REQUIRED });
  const calls = await readToolCalls(input.turn);

  if (approvalRefs.length > 0) {
    // A question alongside an approval needs a second decision, which one click cannot carry.
    if (clientRefs.length > 0) {
      return undefined;
    }
    const approvals: PendingToolApproval[] = [];
    for (const ref of approvalRefs) {
      const call = calls.get(ref.tool_call_id);
      if (call === undefined) {
        // One unreadable call means the batch cannot be completed, so none of it is offered.
        return undefined;
      }
      approvals.push({
        thread_id: ref.thread_id,
        tool_call_id: ref.tool_call_id,
        tool_name: call.name,
        argument_summary: summarizeToolArguments(call.argumentsJson),
      });
    }
    return { type: 'approval', approvals };
  }

  // Exactly one client-side call, and it must be the question tool: a second one, or any other
  // client tool, would be left unresolved by the answer.
  const only = clientRefs.length === 1 ? clientRefs[0] : undefined;
  if (only === undefined) {
    return undefined;
  }
  const call = calls.get(only.tool_call_id);
  if (call?.name !== ASK_USER_QUESTION_TOOL) {
    return undefined;
  }
  const question = questionFrom({ thread_id: only.thread_id, tool_call_id: only.tool_call_id, call });
  return question === undefined ? undefined : { type: 'question', question };
}
