import type { TerminalTurnState } from '@truefoundry/trueforge-core/agent-session';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import {
  ASK_USER_QUESTION_TOOL,
  readPendingAction,
  summarizeToolArguments,
} from '../../../src/integrations/pendingActions';
import { turnEventReader } from './turnEventReader';

const COMPLETED_AT = '2026-09-21T00:00:00.000Z';

function toolCallMessage(calls: { id: string; name: string; args: string }[], id = 'evt-model'): ModelMessageEvent {
  return {
    type: EventType.MODEL_MESSAGE,
    id,
    thread_id: 'main',
    created_at: COMPLETED_AT,
    content: null,
    tool_calls: calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
      tool_info: { type: 'truefoundry-system', name: call.name },
    })),
  };
}

function heldOnApproval(toolCallIds: string[]): TerminalTurnState {
  return {
    status: 'done',
    output: null,
    required_actions: [
      {
        type: EventType.TOOL_APPROVAL_REQUIRED,
        id: 'evt-approval',
        created_at: COMPLETED_AT,
        thread_id: 'worker-1',
        tool_calls: toolCallIds.map(id => ({ id, source_event_id: 'evt-model' })),
      },
    ],
    completed_at: COMPLETED_AT,
  };
}

function heldOnResponse(toolCallIds: string[]): TerminalTurnState {
  return {
    status: 'done',
    output: null,
    required_actions: [
      {
        type: EventType.TOOL_RESPONSE_REQUIRED,
        id: 'evt-response',
        created_at: COMPLETED_AT,
        thread_id: 'main',
        tool_calls: toolCallIds.map(id => ({ id, source_event_id: 'evt-model' })),
      },
    ],
    completed_at: COMPLETED_AT,
  };
}

describe('summarizeToolArguments', () => {
  it('reads as one line of key and value', () => {
    expect(summarizeToolArguments('{"path":"/etc/hosts","force":true,"retries":3}')).toBe(
      'path: /etc/hosts, force: true, retries: 3',
    );
  });

  it.each([
    'api_key',
    'apiKey',
    'authorization',
    'bot_token',
    'client_secret',
    'cookie',
    'db_password',
    'passphrase',
    'private_key',
    'session_id',
    'SIGNING_SECRET',
    'credentials',
  ])('drops the value under %p rather than shortening it', key => {
    const summary = summarizeToolArguments(JSON.stringify({ [key]: 'xoxb-9f3a-super-secret-value' }));
    expect(summary).toBe(`${key}: [redacted]`);
    expect(summary).not.toContain('xoxb');
    expect(summary).not.toContain('9f3a');
  });

  it('cuts one long value without cutting the keys after it', () => {
    const summary = summarizeToolArguments(JSON.stringify({ body: 'x'.repeat(500), channel: 'C0OPS' }));
    expect(summary).toContain('channel: C0OPS');
    expect(summary).toContain('…');
    expect(summary).not.toContain('x'.repeat(200));
  });

  it('caps the whole line however many arguments there are', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field_${String(index)}`, 'y'.repeat(60)]),
    );
    expect(summarizeToolArguments(JSON.stringify(wide)).length).toBeLessThanOrEqual(600);
  });

  it('still reads when the model did not emit JSON', () => {
    expect(summarizeToolArguments('not json at all')).toBe('not json at all');
  });

  it('summarizes a nested value without spilling it', () => {
    const summary = summarizeToolArguments(JSON.stringify({ filter: { owner: 'ada', token: 'nested-secret' } }));
    expect(summary).toContain('filter: {');
    expect(summary.length).toBeLessThanOrEqual(600);
  });
});

describe('readPendingAction', () => {
  it('resolves an approval to its tool name, arguments and owning thread', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([toolCallMessage([{ id: 'call-1', name: 'delete_index', args: '{"index":"prod"}' }])]),
      state: heldOnApproval(['call-1']),
    });

    expect(pending).toEqual({
      type: 'approval',
      approvals: [
        {
          thread_id: 'worker-1',
          tool_call_id: 'call-1',
          tool_name: 'delete_index',
          argument_summary: 'index: prod',
        },
      ],
    });
  });

  it('resolves every held call in one action', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([
        toolCallMessage([
          { id: 'call-1', name: 'delete_index', args: '{}' },
          { id: 'call-2', name: 'drop_table', args: '{}' },
        ]),
      ]),
      state: heldOnApproval(['call-1', 'call-2']),
    });

    expect(pending?.type).toBe('approval');
    expect(pending?.type === 'approval' ? pending.approvals.map(a => a.tool_name) : []).toEqual([
      'delete_index',
      'drop_table',
    ]);
  });

  it('resolves an ask_user_question into its question and options', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([
        toolCallMessage([
          {
            id: 'call-q',
            name: ASK_USER_QUESTION_TOOL,
            args: JSON.stringify({ question: 'Which environment?', options: ['staging', 'production'] }),
          },
        ]),
      ]),
      state: heldOnResponse(['call-q']),
    });

    expect(pending).toEqual({
      type: 'question',
      question: {
        thread_id: 'main',
        tool_call_id: 'call-q',
        question: 'Which environment?',
        options: ['staging', 'production'],
      },
    });
  });

  it('accepts a question with no options, since free text still answers it', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([
        toolCallMessage([
          { id: 'call-q', name: ASK_USER_QUESTION_TOOL, args: JSON.stringify({ question: 'What next?' }) },
        ]),
      ]),
      state: heldOnResponse(['call-q']),
    });

    expect(pending?.type === 'question' ? pending.question.options : undefined).toEqual([]);
  });

  it('prefers the approval when a turn is held on both', async () => {
    const both: TerminalTurnState = {
      status: 'done',
      output: null,
      required_actions: [
        {
          type: EventType.TOOL_RESPONSE_REQUIRED,
          id: 'evt-response',
          created_at: COMPLETED_AT,
          thread_id: 'main',
          tool_calls: [{ id: 'call-q', source_event_id: 'evt-model' }],
        },
        {
          type: EventType.TOOL_APPROVAL_REQUIRED,
          id: 'evt-approval',
          created_at: COMPLETED_AT,
          thread_id: 'main',
          tool_calls: [{ id: 'call-1', source_event_id: 'evt-model' }],
        },
      ],
      completed_at: COMPLETED_AT,
    };

    const pending = await readPendingAction({
      turn: turnEventReader([
        toolCallMessage([
          { id: 'call-q', name: ASK_USER_QUESTION_TOOL, args: JSON.stringify({ question: 'Which?' }) },
          { id: 'call-1', name: 'delete_index', args: '{}' },
        ]),
      ]),
      state: both,
    });

    expect(pending?.type).toBe('approval');
  });

  it('is nothing when a client tool other than the question tool is waiting', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([toolCallMessage([{ id: 'call-x', name: 'render_ui', args: '{}' }])]),
      state: heldOnResponse(['call-x']),
    });

    expect(pending).toBeUndefined();
  });

  it('is nothing when the model message that requested the call is out of the scanned page', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([]),
      state: heldOnApproval(['call-1']),
    });

    expect(pending).toBeUndefined();
  });

  it('reads nothing back for a turn that is not holding anything', async () => {
    let listed = 0;
    const turn = {
      listEvents: (input: { limit: number }) => {
        listed += 1;
        return turnEventReader([]).listEvents(input);
      },
    };

    expect(
      await readPendingAction({
        turn,
        state: { status: 'done', output: null, required_actions: [], completed_at: COMPLETED_AT },
      }),
    ).toBeUndefined();
    expect(listed).toBe(0);
  });
});
