import type { TerminalTurnState } from '@truefoundry/trueforge-core/agent-session';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import { REQUEST_HUMAN_TAKEOVER_TOOL } from '../../../src/computers/requestHumanTakeover';
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

  // There are no keys to redact by, so nothing of it is shown.
  it('hides arguments the model did not emit as JSON', () => {
    const raw = 'Authorization: Bearer sk-live-abcdef';
    expect(summarizeToolArguments(raw)).toBe(`(${String(raw.length)} characters of non-JSON arguments, hidden)`);
    expect(summarizeToolArguments(raw)).not.toContain('sk-live');
  });

  it('redacts a credential nested under a harmless key', () => {
    const summary = summarizeToolArguments(
      JSON.stringify({ request: { headers: { Authorization: 'Bearer sk-live-abcdef' } } }),
    );
    expect(summary).toBe('request: {headers: {Authorization: [redacted]}}');
    expect(summary).not.toContain('sk-live');
  });

  it('redacts a credential inside an array', () => {
    const summary = summarizeToolArguments(JSON.stringify({ headers: [{ name: 'auth', value: 'Bearer sk-live-x' }] }));
    expect(summary).not.toContain('sk-live');
  });

  it.each([
    'Bearer sk-live-abcdef012345',
    'sk-proj-abcdefghijklmnop',
    'xoxb-1111-2222-abcdefghijk',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
    'ghp_abcdefghijklmnopqrstuvwxyz012345',
  ])('redacts %p however innocent its key is', value => {
    expect(summarizeToolArguments(JSON.stringify({ note: value }))).toBe('note: [redacted]');
  });

  // Each of these survived a prefix-anchored rule that skipped anything with a separator.
  it('redacts a credential that is not at the start of the value', () => {
    expect(summarizeToolArguments(JSON.stringify({ note: 'key:sk-live-abcdef012345' }))).toBe('note: [redacted]');
    expect(summarizeToolArguments(JSON.stringify({ header: 'Authorization: Bearer abc.def' }))).toBe(
      'header: [redacted]',
    );
  });

  it('strips the credentials out of a URL but keeps the rest readable', () => {
    expect(summarizeToolArguments(JSON.stringify({ target: 'https://user:pass@host.test/deploy' }))).toBe(
      'target: https://host.test/deploy',
    );
    const withKey = summarizeToolArguments(
      JSON.stringify({ target: 'https://api.example.com/v2/deploy?api_key=sk-live-abcdef&env=prod' }),
    );
    expect(withKey).toContain('https://api.example.com/v2/deploy');
    expect(withKey).toContain('env=prod');
    expect(withKey).not.toContain('sk-live');
  });

  it('redacts an unknown credential format that is long and mixed', () => {
    expect(summarizeToolArguments(JSON.stringify({ note: 'Xk29fQpLm4RtZa81BvNw55' + 'Qq7' }))).toBe('note: [redacted]');
    expect(summarizeToolArguments(JSON.stringify({ note: 'a3f5c9e1b7d2408695facbde1234567890abcdef' }))).toBe(
      'note: [redacted]',
    );
  });

  // The argument line is what an approver decides on, so redaction has to be narrow: a
  // Slack message reading `path: [redacted]` on every file operation is approved blind.
  it.each([
    '/var/log/app/production-2026.log',
    'https://api.example.com/v2/deploy',
    'service-account-prod.iam',
    'restart the api service please',
    'releases/2026-09-21-hotfix',
    'my-very-long-kebab-case-branch-name',
  ])('leaves %p alone, because an approver needs to read it', value => {
    expect(summarizeToolArguments(JSON.stringify({ target: value }))).toBe(`target: ${value}`);
  });

  it('stops naming keys past a sane depth rather than stringifying what is under them', () => {
    const deep = { a: { b: { c: { d: { secret_thing: 'sk-live-abcdef012345' } } } } };
    const summary = summarizeToolArguments(JSON.stringify(deep));
    expect(summary).not.toContain('sk-live');
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

  // Core refuses a resume that leaves a pending call unresolved, and one click cannot carry
  // both a decision and an answer, so the set is not offered at all.
  it('offers nothing when a turn is held on an approval and a question at once', async () => {
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

    expect(pending).toBeUndefined();
  });

  it('offers nothing when one held call cannot be read back', async () => {
    const pending = await readPendingAction({
      // Only `call-1` is in the page; `call-2` is held too, so the batch cannot be completed.
      turn: turnEventReader([toolCallMessage([{ id: 'call-1', name: 'delete_index', args: '{}' }])]),
      state: heldOnApproval(['call-1', 'call-2']),
    });

    expect(pending).toBeUndefined();
  });

  it('offers nothing when two client-side calls are waiting', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([
        toolCallMessage([
          { id: 'call-q', name: ASK_USER_QUESTION_TOOL, args: JSON.stringify({ question: 'Which?' }) },
          { id: 'call-x', name: 'render_ui', args: '{}' },
        ]),
      ]),
      state: heldOnResponse(['call-q', 'call-x']),
    });

    expect(pending).toBeUndefined();
  });

  it('is nothing when a client tool other than the question tool is waiting', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([toolCallMessage([{ id: 'call-x', name: 'render_ui', args: '{}' }])]),
      state: heldOnResponse(['call-x']),
    });

    expect(pending).toBeUndefined();
  });

  it('reads a takeover request with its reason', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([
        toolCallMessage([
          {
            id: 'call-t',
            name: REQUEST_HUMAN_TAKEOVER_TOOL,
            args: JSON.stringify({ reason: '  Log into the supplier portal as accounts@example.com  ' }),
          },
        ]),
      ]),
      state: heldOnResponse(['call-t']),
    });

    expect(pending).toEqual({
      type: 'takeover',
      takeover: {
        thread_id: 'main',
        tool_call_id: 'call-t',
        reason: 'Log into the supplier portal as accounts@example.com',
      },
    });
  });

  it('cuts a takeover reason the model made too long, rather than dropping the request', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([
        toolCallMessage([
          { id: 'call-t', name: REQUEST_HUMAN_TAKEOVER_TOOL, args: JSON.stringify({ reason: 'r'.repeat(900) }) },
        ]),
      ]),
      state: heldOnResponse(['call-t']),
    });

    expect(pending?.type === 'takeover' ? pending.takeover.reason.length : undefined).toBe(500);
  });

  it('is nothing for a takeover request without a reason', async () => {
    const pending = await readPendingAction({
      turn: turnEventReader([toolCallMessage([{ id: 'call-t', name: REQUEST_HUMAN_TAKEOVER_TOOL, args: '{}' }])]),
      state: heldOnResponse(['call-t']),
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
