import { SLACK_INTERACTION_ACTIONS } from '../../../../src/integrations/slack/appCapabilities';
import {
  buildApprovalMessage,
  buildQuestionMessage,
  buildSettledMessage,
  decodeActionValue,
  encodeActionValue,
  type SlackBlock,
} from '../../../../src/integrations/slack/blocks';

const TURN_ID = 'turn-1';

function buttons(blocks: readonly SlackBlock[]) {
  return blocks.flatMap(block => (block.type === 'actions' ? block.elements : []));
}

function texts(blocks: readonly SlackBlock[]): string[] {
  return blocks.flatMap(block => {
    if (block.type === 'section') {
      return [block.text.text];
    }
    return block.type === 'context' ? block.elements.map(element => element.text) : [];
  });
}

describe('buildApprovalMessage', () => {
  const approval = {
    thread_id: 'main',
    tool_call_id: 'call-1',
    tool_name: 'restart_service',
    argument_summary: 'service: api',
  };

  it('offers an approve and a deny button carrying the turn and the call', () => {
    const message = buildApprovalMessage({ turn_id: TURN_ID, intro: '', approvals: [approval] });
    const elements = buttons(message.blocks);

    expect(elements.map(element => element.action_id)).toEqual([
      SLACK_INTERACTION_ACTIONS.approve,
      SLACK_INTERACTION_ACTIONS.deny,
    ]);
    expect(elements.map(element => decodeActionValue(element.value))).toEqual([
      { turn_id: TURN_ID, tool_call_id: 'call-1' },
      { turn_id: TURN_ID, tool_call_id: 'call-1' },
    ]);
  });

  it('names the tool and shows the argument line it was handed', () => {
    const message = buildApprovalMessage({ turn_id: TURN_ID, intro: '', approvals: [approval] });
    expect(texts(message.blocks)).toContain('`restart_service`');
    expect(texts(message.blocks)).toContain('service: api');
    expect(message.text).toBe('Approval needed: restart_service');
  });

  it('keeps the model narration that came with the call', () => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: 'I am about to restart **api**.',
      approvals: [approval],
    });
    // Converted to mrkdwn on the way in, so the thread reads as Slack expects.
    expect(texts(message.blocks)[0]).toBe('I am about to restart *api*.');
  });

  it('gives every held call its own pair of buttons', () => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: '',
      approvals: [approval, { ...approval, tool_call_id: 'call-2', tool_name: 'drop_table' }],
    });
    expect(buttons(message.blocks)).toHaveLength(4);
    expect(message.text).toBe('Approval needed: restart_service, drop_table');
  });

  it('cuts an argument line Slack would refuse rather than dropping the block', () => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: '',
      approvals: [{ ...approval, argument_summary: 'q: '.concat('z'.repeat(5000)) }],
    });
    for (const text of texts(message.blocks)) {
      expect(text.length).toBeLessThanOrEqual(3000);
    }
  });

  it('shows only the summary it was given, so a secret never reaches a block', () => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: '',
      approvals: [{ ...approval, argument_summary: 'token: [redacted]' }],
    });
    expect(JSON.stringify(message)).not.toContain('xoxb');
    expect(texts(message.blocks)).toContain('token: [redacted]');
  });
});

describe('buildQuestionMessage', () => {
  const question = {
    thread_id: 'main',
    tool_call_id: 'call-q',
    question: 'Which environment should I deploy to?',
    options: ['staging', 'production'],
  };

  it('turns each option into a button that carries the answer', () => {
    const message = buildQuestionMessage({ turn_id: TURN_ID, intro: '', question });
    const elements = buttons(message.blocks);

    expect(elements.map(element => element.text.text)).toEqual(['staging', 'production']);
    expect(elements.map(element => element.action_id)).toEqual([
      `${SLACK_INTERACTION_ACTIONS.answer}0`,
      `${SLACK_INTERACTION_ACTIONS.answer}1`,
    ]);
    expect(decodeActionValue(elements[1]?.value ?? '')).toEqual({
      turn_id: TURN_ID,
      tool_call_id: 'call-q',
      option: 'production',
    });
  });

  it('always says a plain reply answers, because that is the only free-text route', () => {
    const message = buildQuestionMessage({ turn_id: TURN_ID, intro: '', question: { ...question, options: [] } });
    expect(buttons(message.blocks)).toHaveLength(0);
    expect(texts(message.blocks)).toContain('Reply in this thread to answer in your own words.');
  });

  it('cuts a label Slack would refuse', () => {
    const message = buildQuestionMessage({
      turn_id: TURN_ID,
      intro: '',
      question: { ...question, options: ['w'.repeat(300)] },
    });
    expect(buttons(message.blocks)[0]?.text.text.length).toBeLessThanOrEqual(75);
  });

  it('never offers more buttons than Slack accepts in one actions block', () => {
    const message = buildQuestionMessage({
      turn_id: TURN_ID,
      intro: '',
      question: { ...question, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    });
    expect(buttons(message.blocks)).toHaveLength(5);
  });
});

describe('the value a button carries', () => {
  it('round-trips', () => {
    const value = { turn_id: TURN_ID, tool_call_id: 'call-1', option: 'production' };
    expect(decodeActionValue(encodeActionValue(value))).toEqual(value);
  });

  it('stays inside the 2,000 characters Slack allows', () => {
    const encoded = encodeActionValue({ turn_id: TURN_ID, tool_call_id: 'call-1', option: 'o'.repeat(4000) });
    expect(encoded.length).toBeLessThanOrEqual(2000);
  });

  it.each(['', 'not json', '"a string"', '{"turn_id":1}', '{"tool_call_id":"c"}', '{"turn_id":"t"}'])(
    'refuses %p rather than resuming something it cannot name',
    raw => {
      expect(decodeActionValue(raw)).toBeUndefined();
    },
  );
});

describe('buildSettledMessage', () => {
  it('replaces the buttons with the decision', () => {
    const message = buildSettledMessage('Approved by <@U0ADMIN>.');
    expect(buttons(message.blocks)).toHaveLength(0);
    expect(texts(message.blocks)).toEqual(['Approved by <@U0ADMIN>.']);
  });
});
