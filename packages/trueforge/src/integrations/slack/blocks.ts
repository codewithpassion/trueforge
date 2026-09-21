/**
 * Block Kit messages for a turn held on a human decision, and for what replaces one once the
 * decision is in. Every button carries the turn and tool call it belongs to, so nothing about
 * the pending turn has to be remembered between the post and the click.
 */
import type { PendingQuestion, PendingToolApproval } from '../pendingActions';
import { SLACK_INTERACTION_ACTIONS } from './appCapabilities';
import { toMrkdwn } from './mrkdwn';

/** Slack refuses a button label over 75 characters and a `value` over 2,000. */
const BUTTON_TEXT_MAX = 75;
const BUTTON_VALUE_MAX = 2000;
/** Slack refuses a section `text` over 3,000 characters. */
const SECTION_TEXT_MAX = 3000;
/** Slack allows at most five elements in one actions block; `ask_user_question` caps at five too. */
const MAX_OPTION_BUTTONS = 5;

interface SlackTextObject {
  type: 'mrkdwn' | 'plain_text';
  text: string;
  emoji?: boolean;
}

interface SlackSectionBlock {
  type: 'section';
  text: SlackTextObject;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackTextObject[];
}

interface SlackButtonElement {
  type: 'button';
  action_id: string;
  text: SlackTextObject;
  value: string;
  style?: 'primary' | 'danger';
}

interface SlackActionsBlock {
  type: 'actions';
  block_id: string;
  elements: SlackButtonElement[];
}

export type SlackBlock = SlackSectionBlock | SlackContextBlock | SlackActionsBlock;

/** A Block Kit message: `text` is the notification fallback Slack still requires. */
export interface SlackBlockMessage {
  text: string;
  blocks: SlackBlock[];
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function section(text: string): SlackSectionBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: clamp(text, SECTION_TEXT_MAX) } };
}

function context(text: string): SlackContextBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: clamp(text, SECTION_TEXT_MAX) }] };
}

/**
 * What a button hands back. Kept to ids the server re-checks against the turn's own pending
 * actions, so a forged value buys nothing.
 */
export interface SlackActionValue {
  turn_id: string;
  tool_call_id: string;
  /** Present on an answer button: the option text that becomes the tool response. */
  option?: string;
}

export function encodeActionValue(value: SlackActionValue): string {
  return clamp(JSON.stringify(value), BUTTON_VALUE_MAX);
}

export function decodeActionValue(raw: string): SlackActionValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const record: Record<string, unknown> = { ...parsed };
  const turnId = record['turn_id'];
  const toolCallId = record['tool_call_id'];
  const option = record['option'];
  if (typeof turnId !== 'string' || typeof toolCallId !== 'string') {
    return undefined;
  }
  if (option !== undefined && typeof option !== 'string') {
    return undefined;
  }
  return option === undefined
    ? { turn_id: turnId, tool_call_id: toolCallId }
    : { turn_id: turnId, tool_call_id: toolCallId, option };
}

function introBlocks(intro: string): SlackBlock[] {
  return intro.trim().length === 0 ? [] : [section(toMrkdwn(intro))];
}

/**
 * One message per held turn, with an approve/deny pair per tool call. The argument line is
 * already redacted and truncated by the layer, so nothing here has to guess what is secret.
 */
export function buildApprovalMessage(input: {
  turn_id: string;
  intro: string;
  approvals: readonly PendingToolApproval[];
}): SlackBlockMessage {
  const blocks: SlackBlock[] = [
    ...introBlocks(input.intro),
    section(
      input.approvals.length === 1
        ? '*Approval needed*'
        : `*Approval needed* for ${String(input.approvals.length)} tool calls`,
    ),
  ];
  for (const approval of input.approvals) {
    blocks.push(section(`\`${approval.tool_name}\``));
    if (approval.argument_summary.length > 0) {
      blocks.push(context(approval.argument_summary));
    }
    const value = encodeActionValue({ turn_id: input.turn_id, tool_call_id: approval.tool_call_id });
    blocks.push({
      type: 'actions',
      block_id: `approval:${clamp(approval.tool_call_id, 200)}`,
      elements: [
        {
          type: 'button',
          action_id: SLACK_INTERACTION_ACTIONS.approve,
          text: { type: 'plain_text', text: 'Approve', emoji: false },
          value,
          style: 'primary',
        },
        {
          type: 'button',
          action_id: SLACK_INTERACTION_ACTIONS.deny,
          text: { type: 'plain_text', text: 'Deny', emoji: false },
          value,
          style: 'danger',
        },
      ],
    });
  }
  const names = input.approvals.map(approval => approval.tool_name).join(', ');
  return { text: `Approval needed: ${names}`, blocks };
}

/**
 * The question, its options as buttons, and the instruction that covers everything the options
 * do not: a plain reply in the thread answers too, and is the only way to answer in free text.
 */
export function buildQuestionMessage(input: {
  turn_id: string;
  intro: string;
  question: PendingQuestion;
}): SlackBlockMessage {
  const { question } = input;
  const blocks: SlackBlock[] = [...introBlocks(input.intro), section(toMrkdwn(question.question))];
  const options = question.options.slice(0, MAX_OPTION_BUTTONS);
  if (options.length > 0) {
    blocks.push({
      type: 'actions',
      block_id: `question:${clamp(question.tool_call_id, 200)}`,
      elements: options.map((option, index) => ({
        type: 'button',
        action_id: `${SLACK_INTERACTION_ACTIONS.answer}${String(index)}`,
        text: { type: 'plain_text', text: clamp(option, BUTTON_TEXT_MAX), emoji: false },
        value: encodeActionValue({ turn_id: input.turn_id, tool_call_id: question.tool_call_id, option }),
      })),
    });
  }
  blocks.push(context('Reply in this thread to answer in your own words.'));
  return { text: `Question: ${question.question}`, blocks };
}

/** Replaces the buttons with who decided and what, so the message cannot be acted on twice. */
export function buildSettledMessage(summary: string): SlackBlockMessage {
  return { text: summary, blocks: [section(summary)] };
}
