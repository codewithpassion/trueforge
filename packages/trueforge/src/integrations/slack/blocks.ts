/**
 * Block Kit messages for a turn held on a human decision, and for what replaces one once the
 * decision is in. Every button carries the turn and tool call it belongs to, so nothing about
 * the pending turn has to be remembered between the post and the click.
 */
import type { PendingQuestion, PendingTakeoverRequest, PendingToolApproval } from '../pendingActions';
import { SLACK_INTERACTION_ACTIONS } from './appCapabilities';
import { escapeSlackText, toMrkdwn } from './mrkdwn';

/** Slack refuses a button label over 75 characters and a `value` over 2,000. */
const BUTTON_TEXT_MAX = 75;
/** Leaves room for the ids and the JSON around it, so the encoded value always fits. */
const BUTTON_VALUE_OPTION_MAX = 1500;
/** Slack refuses a section `text` over 3,000 characters. */
const SECTION_TEXT_MAX = 3000;
/** Slack allows at most five elements in one actions block; `ask_user_question` caps at five too. */
const MAX_OPTION_BUTTONS = 5;
/**
 * Slack refuses a message over 50 blocks. Each listed call costs two, so this leaves room for
 * the intro, the header, the overflow note and the one actions block.
 */
const MAX_LISTED_APPROVALS = 20;

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
  /** Present on an answer button; an approval settles every call the turn holds, so it has none. */
  tool_call_id?: string;
  /** Present on an answer button: the option text that becomes the tool response. */
  option?: string;
}

/**
 * Cutting the encoded JSON would make the value undecodable and the button dead, so the one
 * part that can be long is cut before it is encoded.
 */
export function encodeActionValue(value: SlackActionValue): string {
  return JSON.stringify(
    value.option === undefined ? value : { ...value, option: clamp(value.option, BUTTON_VALUE_OPTION_MAX) },
  );
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
  if (typeof turnId !== 'string') {
    return undefined;
  }
  if (toolCallId !== undefined && typeof toolCallId !== 'string') {
    return undefined;
  }
  if (option !== undefined && typeof option !== 'string') {
    return undefined;
  }
  return {
    turn_id: turnId,
    ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    ...(option === undefined ? {} : { option }),
  };
}

function introBlocks(intro: string): SlackBlock[] {
  return intro.trim().length === 0 ? [] : [section(toMrkdwn(intro))];
}

/**
 * One message per held turn, and **one** decision for all of it. Core refuses a resume that
 * leaves any pending call unresolved, so a per-call button pair would produce a turn nothing
 * could ever settle; the pair therefore covers every call the message lists.
 *
 * The argument line is already redacted and truncated by the layer, so nothing here has to
 * guess what is secret — but everything a model produced is escaped, or `<!channel>` in a tool
 * argument would ping the channel from inside a block.
 */
export function buildApprovalMessage(input: {
  turn_id: string;
  intro: string;
  approvals: readonly PendingToolApproval[];
}): SlackBlockMessage {
  const total = input.approvals.length;
  const listed = input.approvals.slice(0, MAX_LISTED_APPROVALS);
  const blocks: SlackBlock[] = [
    ...introBlocks(input.intro),
    section(total === 1 ? '*Approval needed*' : `*Approval needed* for ${String(total)} tool calls`),
  ];
  for (const approval of listed) {
    blocks.push(section(`\`${escapeSlackText(approval.tool_name)}\``));
    if (approval.argument_summary.length > 0) {
      blocks.push(context(escapeSlackText(approval.argument_summary)));
    }
  }
  if (total > listed.length) {
    blocks.push(context(`…and ${String(total - listed.length)} more, all covered by one decision.`));
  }
  const value = encodeActionValue({ turn_id: input.turn_id });
  const allOfThem = total > 1;
  blocks.push({
    type: 'actions',
    block_id: `approval:${clamp(input.turn_id, 200)}`,
    elements: [
      {
        type: 'button',
        action_id: SLACK_INTERACTION_ACTIONS.approve,
        text: { type: 'plain_text', text: allOfThem ? 'Approve all' : 'Approve', emoji: false },
        value,
        style: 'primary',
      },
      {
        type: 'button',
        action_id: SLACK_INTERACTION_ACTIONS.deny,
        text: { type: 'plain_text', text: allOfThem ? 'Deny all' : 'Deny', emoji: false },
        value,
        style: 'danger',
      },
    ],
  });
  const names = listed.map(approval => approval.tool_name).join(', ');
  return { text: `Approval needed: ${escapeSlackText(names)}`, blocks };
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
  const blocks: SlackBlock[] = [...introBlocks(input.intro), section(escapeSlackText(question.question))];
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
  return { text: `Question: ${escapeSlackText(question.question)}`, blocks };
}

/**
 * A request for a person to take over the computer's desktop. No buttons: it is settled on the
 * agent's Screen page, where the person takes control and hands it back.
 */
export function buildTakeoverMessage(input: {
  intro: string;
  takeover: PendingTakeoverRequest;
  /** Undefined when the server has no public base URL to link from. */
  screen_url: string | undefined;
}): SlackBlockMessage {
  const reason = escapeSlackText(input.takeover.reason);
  const where =
    input.screen_url === undefined
      ? 'Open this agent’s Screen page in TrueForge'
      : `<${input.screen_url}|Open this agent’s screen>`;
  return {
    text: `A person is needed on the computer: ${reason}`,
    blocks: [
      ...introBlocks(input.intro),
      section(`*A person is needed on the computer:* ${reason}`),
      context(`${where}, take control, finish the step and hand it back. The agent carries on from there.`),
    ],
  };
}

/** Replaces the buttons with who decided and what, so the message cannot be acted on twice. */
export function buildSettledMessage(summary: string): SlackBlockMessage {
  return { text: summary, blocks: [section(summary)] };
}
