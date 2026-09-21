import { CancellationReason, type TurnHandle } from '@truefoundry/trueforge-core/agent-session';
import type {
  MCPAuthRequiredEvent,
  ModelMessageEvent,
  ToolApprovalRequiredEvent,
} from '@truefoundry/trueforge-core/core/events/schema';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import { buildDeliveryContent } from '../../../src/integrations/deliveryContent';
import { turnEventReader } from './turnEventReader';

function modelMessage(content: ModelMessageEvent['content']): ModelMessageEvent {
  return {
    type: EventType.MODEL_MESSAGE,
    id: 'evt-1',
    thread_id: 'main',
    created_at: new Date().toISOString(),
    content,
  };
}

const COMPLETED_AT = '2026-09-16T00:00:00.000Z';
const TURN_ID = 'turn-1';

/** No pending action, so nothing reads back events. */
const noEvents: Pick<TurnHandle, 'listEvents'> = turnEventReader([]);

describe('buildDeliveryContent', () => {
  it('posts the final assistant text', async () => {
    expect(
      await buildDeliveryContent({
        turn: noEvents,
        turn_id: TURN_ID,
        interactive: true,
        state: {
          status: 'done',
          output: modelMessage('  the deploy is green  '),
          required_actions: [],
          completed_at: COMPLETED_AT,
        },
      }),
    ).toEqual({ type: 'message', text: 'the deploy is green' });
  });

  it('joins content parts, including a refusal', async () => {
    expect(
      await buildDeliveryContent({
        turn: noEvents,
        turn_id: TURN_ID,
        interactive: true,
        state: {
          status: 'done',
          output: modelMessage([
            { type: 'text', text: 'first. ' },
            { type: 'refusal', refusal: 'I cannot help with that.' },
          ]),
          required_actions: [],
          completed_at: COMPLETED_AT,
        },
      }),
    ).toEqual({ type: 'message', text: 'first. I cannot help with that.' });
  });

  it('posts a status line when the turn ended without an answer', async () => {
    expect(
      await buildDeliveryContent({
        turn: noEvents,
        turn_id: TURN_ID,
        interactive: true,
        state: { status: 'done', output: null, required_actions: [], completed_at: COMPLETED_AT },
      }),
    ).toEqual({ type: 'status', state: 'done', detail: 'The agent finished without a reply.' });
  });

  it('posts a status line for a cancelled turn', async () => {
    expect(
      await buildDeliveryContent({
        turn: noEvents,
        turn_id: TURN_ID,
        interactive: true,
        state: {
          status: 'cancelled',
          reason: CancellationReason.ClientCancelled,
          completed_at: COMPLETED_AT,
        },
      }),
    ).toMatchObject({ type: 'status', state: 'cancelled' });
  });

  it('keeps a failed run generic, so a provider message cannot reach the channel', async () => {
    expect(
      await buildDeliveryContent({
        turn: noEvents,
        turn_id: TURN_ID,
        interactive: true,
        state: { status: 'error', message: 'model timed out', completed_at: COMPLETED_AT },
      }),
    ).toEqual({
      type: 'status',
      state: 'error',
      detail: 'The agent could not finish this run.',
    });
  });

  it('asks for the approval rather than posting the narration that precedes it', async () => {
    const approvalRequired: ToolApprovalRequiredEvent = {
      type: EventType.TOOL_APPROVAL_REQUIRED,
      id: 'evt-2',
      created_at: COMPLETED_AT,
      thread_id: 'main',
      tool_calls: [{ id: 'call-1', source_event_id: 'evt-1' }],
    };
    const narration: ModelMessageEvent = {
      ...modelMessage('I will restart the service now.'),
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'restart_service', arguments: '{"service":"api","token":"xoxb-secret"}' },
          tool_info: { type: 'mcp', server_id: 'srv-1', server_name: 'ops', name: 'restart_service' },
        },
      ],
    };

    const content = await buildDeliveryContent({
      turn: turnEventReader([narration]),
      turn_id: TURN_ID,
      interactive: true,
      state: {
        status: 'done',
        output: narration,
        required_actions: [approvalRequired],
        completed_at: COMPLETED_AT,
      },
    });

    expect(content).toEqual({
      type: 'approval_request',
      turn_id: TURN_ID,
      intro: 'I will restart the service now.',
      approvals: [
        {
          thread_id: 'main',
          tool_call_id: 'call-1',
          tool_name: 'restart_service',
          argument_summary: 'service: api, token: [redacted]',
        },
      ],
    });
  });

  it('falls back to the status line when the pending action is one no channel can answer', async () => {
    const authRequired: MCPAuthRequiredEvent = {
      type: EventType.MCP_AUTH_REQUIRED,
      id: 'evt-3',
      created_at: COMPLETED_AT,
      thread_id: 'main',
      mcp_servers: [],
    };

    expect(
      await buildDeliveryContent({
        turn: noEvents,
        turn_id: TURN_ID,
        interactive: true,
        state: { status: 'done', output: null, required_actions: [authRequired], completed_at: COMPLETED_AT },
      }),
    ).toEqual({ type: 'status', state: 'done', detail: 'The agent is waiting for input it cannot ask for here.' });
  });
});
