import type { ToolApprovalOption as AuiToolApprovalOption, ToolCallMessagePartProps } from '@assistant-ui/react';
import { parse as parsePartialJson } from 'partial-json';

import type { ToolCallStatus } from '../atoms/ToolCallCard.js';

export type ApprovalOptionView = {
  id: string;
  label: string;
  isAllow: boolean;
  grants?: unknown;
  confirm?: Record<string, unknown>;
};

export const SUB_AGENT_TOOL_NAME = 'create_sub_agent';
export const ASK_USER_TOOL_NAME = 'ask_user_question';

/** A client-side tool: the agent asks a person to do a step on its computer's desktop. */
export const REQUEST_HUMAN_TAKEOVER_TOOL_NAME = 'request_human_takeover';

/** Desktop tools of an agent that drives a computer's screen. */
export const COMPUTER_TOOL_NAMES = new Set([
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_drag',
  'computer_clipboard_read',
  'computer_clipboard_write',
]);

/** Tool names that should be rendered as a sandbox execution card. */
export const SANDBOX_TOOL_NAMES = new Set(['exec', 'sandbox_exec']);

/** MCP meta-tools that wrap actual tool calls (deferred tool loading). */
export const MCP_META_TOOLS = new Set(['call_tool', 'list_tools', 'get_tool_info', 'get_tool_output_schema']);

const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  'allow-once': 'Allow',
  'allow-always': 'Always allow',
  'reject-once': 'Deny',
  'reject-always': 'Always deny',
};

const isAllowKind = (kind: string) => kind === 'allow-once' || kind === 'allow-always';

type JsonParseResult = { success: true; value: unknown; isPartial: boolean } | { success: false };

function parseJsonIncrementally(content: string): JsonParseResult {
  try {
    return { success: true, value: JSON.parse(content), isPartial: false };
  } catch {
    const trimmed = content.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return { success: false };

    try {
      return { success: true, value: parsePartialJson(content), isPartial: true };
    } catch {
      return { success: false };
    }
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function parseAskUserQuestionArgs(argsText: string | undefined): {
  question?: string;
  options?: string[];
} {
  if (!argsText) return {};
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const question = typeof record.question === 'string' ? record.question : undefined;
    const options = Array.isArray(record.options)
      ? record.options.filter((item): item is string => typeof item === 'string')
      : undefined;
    return { question, options };
  } catch {
    return {};
  }
}

export function getAskUserAnswerResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof result === 'object' && 'content' in result) {
    const content = (result as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
  }
  return undefined;
}

export function hasPendingAskUserResponse(part: Pick<ToolCallMessagePartProps, 'interrupt' | 'result'>): boolean {
  return part.interrupt != null && part.result === undefined;
}

export function hasPendingToolApproval(
  approval: { approved?: boolean; resolution?: 'cancelled' | 'expired' } | undefined,
) {
  return approval != null && approval.approved === undefined && approval.resolution === undefined;
}

export function buildApprovalOptions(options: readonly AuiToolApprovalOption[] | undefined): ApprovalOptionView[] {
  const declared = options?.filter(o => Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, o.kind));
  if (declared && declared.length > 0) {
    const allow = declared.filter(o => isAllowKind(o.kind));
    const reject = declared.filter(o => !isAllowKind(o.kind));
    const mapped: ApprovalOptionView[] = [...allow, ...reject].map(o => ({
      id: o.id,
      label: o.label ?? APPROVAL_OPTION_DEFAULT_LABELS[o.kind] ?? o.id,
      isAllow: isAllowKind(o.kind),
      grants: o.grants,
      confirm: o.confirm != null ? (typeof o.confirm === 'object' ? o.confirm : {}) : undefined,
    }));
    if (reject.length === 0) {
      mapped.push({ id: '__deny', label: 'Deny', isAllow: false, confirm: {} });
    }
    return mapped;
  }
  return [
    { id: '__allow', label: 'Allow', isAllow: true },
    { id: '__deny', label: 'Deny', isAllow: false, confirm: {} },
  ];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export function toStatus(statusType: string | undefined): ToolCallStatus {
  if (statusType === 'complete') return 'success';
  if (statusType === 'incomplete') return 'error';
  return 'running';
}

export function parseSandboxArgs(argsText: string | undefined): {
  command?: string;
  intent?: string;
  argsJson?: string;
} {
  if (!argsText) return {};
  const parsed = parseJsonIncrementally(argsText);
  if (!parsed.success || !isUnknownRecord(parsed.value)) return { argsJson: argsText };

  return {
    command: typeof parsed.value.command === 'string' ? parsed.value.command : undefined,
    intent: typeof parsed.value.intent === 'string' ? parsed.value.intent : undefined,
    argsJson: parsed.isPartial ? argsText : JSON.stringify(parsed.value, null, 2),
  };
}

export function parseSandboxResult(result: string | undefined): {
  exitCode?: number | null;
  resultText?: string;
  resultJson?: string;
} {
  if (result === undefined) return {};
  const parsed = parseJsonIncrementally(result);
  if (!parsed.success || !isUnknownRecord(parsed.value)) return { resultText: result };

  const response = isUnknownRecord(parsed.value.response) ? parsed.value.response : undefined;
  const exitCode = typeof response?.exitCode === 'number' ? response.exitCode : null;
  const resultText = typeof response?.result === 'string' ? response.result : undefined;
  return {
    exitCode,
    resultText,
    resultJson: parsed.isPartial ? result : JSON.stringify(parsed.value, null, 2),
  };
}

export function parseMcpToolArgs(argsText: string | undefined): {
  mcpServer?: string;
  innerToolName?: string;
  input?: unknown;
} {
  if (!argsText) return {};
  try {
    const parsed = JSON.parse(argsText) as {
      mcp_server?: string;
      tool_name?: string;
      input?: unknown;
    };
    return {
      mcpServer: parsed.mcp_server,
      innerToolName: parsed.tool_name,
      input: parsed.input,
    };
  } catch {
    return {};
  }
}

export function getJsonDisplayValue(content: string | undefined): {
  value: string;
  isJson: boolean;
} {
  if (!content?.trim()) return { value: '', isJson: false };
  const trimmed = content.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    return { value: content, isJson: false };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return { value: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { value: content, isJson: false };
  }
}

export function getToolResultContent(content: unknown): {
  data: string;
  isJson: boolean;
} {
  try {
    if (!content) return { isJson: false, data: '' };

    const parsedResult = typeof content === 'string' && content.trim().startsWith('{') ? JSON.parse(content) : content;

    if (
      typeof parsedResult === 'object' &&
      parsedResult != null &&
      Array.isArray((parsedResult as { content?: unknown }).content)
    ) {
      const text = (parsedResult as { content: Array<{ text?: unknown }> }).content[0]?.text || '';
      const display = getJsonDisplayValue(typeof text === 'string' ? text : JSON.stringify(text));
      return { data: display.value, isJson: display.isJson };
    }
    const display = getJsonDisplayValue(typeof parsedResult === 'string' ? parsedResult : JSON.stringify(parsedResult));
    return { data: display.value, isJson: display.isJson };
  } catch {
    return { data: String(content), isJson: false };
  }
}

export function resolveSubAgentMeta(part: ToolCallMessagePartProps): {
  agentName: string;
  instruction: string;
  stepCount: number;
} {
  const artifactSubAgent = (
    part as {
      artifact?: {
        subAgents?: Array<{
          title?: string;
          agentInfo?: { name?: string; input?: string };
        }>;
      };
    }
  ).artifact?.subAgents?.[0];
  const firstNested = part.messages?.[0];
  const subAgent = (
    firstNested?.metadata?.custom as { subAgent?: { title?: string; name?: string; input?: string } } | undefined
  )?.subAgent;
  return {
    agentName:
      subAgent?.title ??
      subAgent?.name ??
      artifactSubAgent?.title ??
      artifactSubAgent?.agentInfo?.name ??
      part.toolName,
    instruction: subAgent?.input ?? artifactSubAgent?.agentInfo?.input ?? '',
    stepCount: part.messages?.length ?? 0,
  };
}

export function mcpDisplayName(
  toolName: string,
  mcpServer: string | undefined,
  innerToolName: string | undefined,
): string {
  if (toolName === 'list_tools' && mcpServer) {
    return `list_tools (${mcpServer})`;
  }
  if (toolName === 'call_tool' && innerToolName) {
    return mcpServer ? `call_tool: ${innerToolName} (${mcpServer})` : `call_tool: ${innerToolName}`;
  }
  if ((toolName === 'get_tool_info' || toolName === 'get_tool_output_schema') && innerToolName && mcpServer) {
    return `${toolName}: ${innerToolName} (${mcpServer})`;
  }
  return toolName;
}

function parseArgsRecord(argsText: string | undefined): Record<string, unknown> {
  if (!argsText) return {};
  const parsed = parseJsonIncrementally(argsText);
  return parsed.success && isUnknownRecord(parsed.value) ? parsed.value : {};
}

function readPoint(value: unknown): string | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const { x, y } = value;
  return typeof x === 'number' && typeof y === 'number' ? `(${String(x)}, ${String(y)})` : undefined;
}

const TYPED_PREVIEW_LENGTH = 40;

/** One line saying what a desktop tool call did, for its card title. */
export function describeComputerAction(toolName: string, argsText: string | undefined): string {
  const args = parseArgsRecord(argsText);
  const at = readPoint(args);
  switch (toolName) {
    case 'computer_screenshot':
      return 'Screenshot';
    case 'computer_click': {
      const count =
        typeof args.count === 'number' && args.count > 1 ? `${args.count === 2 ? 'Double' : 'Triple'}-click` : 'Click';
      const button = typeof args.button === 'string' && args.button !== 'left' ? ` (${args.button})` : '';
      return at === undefined ? `${count}${button}` : `${count}${button} at ${at}`;
    }
    case 'computer_type': {
      if (typeof args.text !== 'string') return 'Type';
      const text = args.text.length > TYPED_PREVIEW_LENGTH ? `${args.text.slice(0, TYPED_PREVIEW_LENGTH)}…` : args.text;
      return `Type “${text}”`;
    }
    case 'computer_key':
      return typeof args.keys === 'string' ? `Press ${args.keys}` : 'Press a key';
    case 'computer_scroll':
      return at === undefined ? 'Scroll' : `Scroll at ${at}`;
    case 'computer_drag': {
      const from = readPoint(args.from);
      const to = readPoint(args.to);
      return from !== undefined && to !== undefined ? `Drag from ${from} to ${to}` : 'Drag';
    }
    case 'computer_clipboard_read':
      return 'Read the clipboard';
    case 'computer_clipboard_write':
      return 'Write the clipboard';
    default:
      return toolName;
  }
}

export function parseTakeoverReason(argsText: string | undefined): string | undefined {
  const { reason } = parseArgsRecord(argsText);
  return typeof reason === 'string' && reason.trim() !== '' ? reason : undefined;
}

export type TakeoverAnswer = {
  /** `answered`: a reply typed in chat rather than a hand-back or cancel; `note` holds it. */
  outcome: 'completed' | 'cancelled' | 'answered';
  note: string | null;
  /** Absent from answers recorded before the answering person was named. */
  answeredBy?: 'session_creator' | 'another_user';
};

/** The answer a takeover got, read from its tool result; undefined while it is still waiting. */
export function parseTakeoverAnswer(result: unknown): TakeoverAnswer | undefined {
  const text = getAskUserAnswerResult(result);
  if (text === undefined) return undefined;
  const parsed = parseJsonIncrementally(text);
  const reply: TakeoverAnswer = { outcome: 'answered', note: text };
  if (!parsed.success || parsed.isPartial || !isUnknownRecord(parsed.value)) return reply;
  const { outcome, note, answered_by: answeredBy } = parsed.value;
  if (outcome !== 'completed' && outcome !== 'cancelled') return reply;
  return {
    outcome,
    note: typeof note === 'string' && note !== '' ? note : null,
    ...(answeredBy === 'session_creator' || answeredBy === 'another_user' ? { answeredBy } : {}),
  };
}
