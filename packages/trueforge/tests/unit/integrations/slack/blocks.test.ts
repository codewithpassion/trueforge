import { SLACK_INTERACTION_ACTIONS } from '../../../../src/integrations/slack/appCapabilities';
import {
  buildApprovalMessage,
  buildQuestionMessage,
  buildSettledMessage,
  buildTakeoverMessage,
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

describe('buildTakeoverMessage', () => {
  const takeover = { thread_id: 'main', tool_call_id: 'call-1', reason: 'Log into <!channel> the portal' };

  it('shows the reason escaped, links the Screen page and offers no buttons', () => {
    const message = buildTakeoverMessage({
      intro: '',
      takeover,
      screen_url: 'https://trueforge.test/agents/agent-1/screen',
    });

    expect(buttons(message.blocks)).toEqual([]);
    expect(texts(message.blocks)).toEqual([
      '*A person is needed on the computer:* Log into &lt;!channel&gt; the portal',
      '<https://trueforge.test/agents/agent-1/screen|Open this agent’s screen>, take control, finish the step and hand it back. The agent carries on from there.',
    ]);
  });

  it('names the Screen page in words when there is no public URL to link', () => {
    const message = buildTakeoverMessage({ intro: 'Stuck at login.', takeover, screen_url: undefined });

    expect(texts(message.blocks)[0]).toBe('Stuck at login.');
    expect(texts(message.blocks)[2]).toMatch(/^Open this agent’s Screen page in TrueForge, take control/);
  });
});

describe('buildApprovalMessage', () => {
  const approval = {
    thread_id: 'main',
    tool_call_id: 'call-1',
    tool_name: 'restart_service',
    argument_summary: 'service: api',
  };

  it('offers an approve and a deny button naming the turn the decision settles', () => {
    const message = buildApprovalMessage({ turn_id: TURN_ID, intro: '', approvals: [approval] });
    const elements = buttons(message.blocks);

    expect(elements.map(element => element.action_id)).toEqual([
      SLACK_INTERACTION_ACTIONS.approve,
      SLACK_INTERACTION_ACTIONS.deny,
    ]);
    // No call id: core refuses a resume that leaves a held call unresolved, so one decision
    // covers all of them and the resume reads the set off the turn itself.
    expect(elements.map(element => decodeActionValue(element.value))).toEqual([
      { turn_id: TURN_ID },
      { turn_id: TURN_ID },
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

  it('lists every held call under one decision, because a partial resume is refused', () => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: '',
      approvals: [approval, { ...approval, tool_call_id: 'call-2', tool_name: 'drop_table' }],
    });

    expect(buttons(message.blocks)).toHaveLength(2);
    expect(buttons(message.blocks).map(element => element.text.text)).toEqual(['Approve all', 'Deny all']);
    expect(texts(message.blocks)).toContain('*Approval needed* for 2 tool calls');
    expect(texts(message.blocks)).toContain('`drop_table`');
    expect(message.text).toBe('Approval needed: restart_service, drop_table');
  });

  it('stays inside Slack’s block limit when a turn holds far too many calls', () => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: 'x',
      approvals: Array.from({ length: 40 }, (_, index) => ({ ...approval, tool_call_id: `call-${String(index)}` })),
    });

    expect(message.blocks.length).toBeLessThanOrEqual(50);
    expect(texts(message.blocks)).toContain('…and 20 more, all covered by one decision.');
    // Still one decision, so the overflow is decided too.
    expect(buttons(message.blocks)).toHaveLength(2);
  });

  it.each([
    ['<!channel> deploy now', '&lt;!channel&gt; deploy now'],
    ['<@U0OTHER>', '&lt;@U0OTHER&gt;'],
    ['<https://evil.test|Approve here>', '&lt;https://evil.test|Approve here&gt;'],
    ['a & b', 'a &amp; b'],
  ])('escapes %p in the argument line, so a tool argument cannot mark up the message', (raw, escaped) => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: '',
      approvals: [{ ...approval, argument_summary: raw }],
    });
    expect(texts(message.blocks)).toContain(escaped);
  });

  it('escapes the tool name too, since the model chose it', () => {
    const message = buildApprovalMessage({
      turn_id: TURN_ID,
      intro: '',
      approvals: [{ ...approval, tool_name: '<!here>' }],
    });
    expect(texts(message.blocks)).toContain('`&lt;!here&gt;`');
    expect(message.text).toBe('Approval needed: &lt;!here&gt;');
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

  it('escapes the question, since the model wrote it', () => {
    const message = buildQuestionMessage({
      turn_id: TURN_ID,
      intro: '',
      question: { ...question, question: 'Deploy <!channel>?' },
    });
    expect(texts(message.blocks)).toContain('Deploy &lt;!channel&gt;?');
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

  it('stays inside the 2,000 characters Slack allows, and still decodes', () => {
    const encoded = encodeActionValue({ turn_id: TURN_ID, tool_call_id: 'call-1', option: 'o'.repeat(4000) });

    expect(encoded.length).toBeLessThanOrEqual(2000);
    // Cutting the encoded JSON instead of the option would leave a value nothing can read back.
    expect(decodeActionValue(encoded)).toMatchObject({ turn_id: TURN_ID, tool_call_id: 'call-1' });
    expect(decodeActionValue(encoded)?.option).toMatch(/^o+…$/);
  });

  it('carries the turn alone for an approval', () => {
    expect(decodeActionValue(encodeActionValue({ turn_id: TURN_ID }))).toEqual({ turn_id: TURN_ID });
  });

  it.each(['', 'not json', '"a string"', '{"turn_id":1}', '{"tool_call_id":"c"}'])(
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
