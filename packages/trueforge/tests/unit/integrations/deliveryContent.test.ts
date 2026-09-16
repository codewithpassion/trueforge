import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { EventType } from '@truefoundry/trueforge-core/core/events/schema';
import { buildDeliveryContent } from '../../../src/integrations/deliveryContent';

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

describe('buildDeliveryContent', () => {
  it('posts the final assistant text', () => {
    expect(
      buildDeliveryContent({
        status: 'done',
        output: modelMessage('  the deploy is green  '),
        required_actions: [],
        completed_at: COMPLETED_AT,
      }),
    ).toEqual({ type: 'message', text: 'the deploy is green' });
  });

  it('joins content parts, including a refusal', () => {
    expect(
      buildDeliveryContent({
        status: 'done',
        output: modelMessage([
          { type: 'text', text: 'first. ' },
          { type: 'refusal', refusal: 'I cannot help with that.' },
        ]),
        required_actions: [],
        completed_at: COMPLETED_AT,
      }),
    ).toEqual({ type: 'message', text: 'first. I cannot help with that.' });
  });

  it('posts a status line when the turn ended without an answer', () => {
    expect(
      buildDeliveryContent({ status: 'done', output: null, required_actions: [], completed_at: COMPLETED_AT }),
    ).toEqual({ type: 'status', state: 'done', detail: 'The agent finished without a reply.' });
  });

  it('posts a status line for a cancelled turn', () => {
    expect(
      buildDeliveryContent({
        status: 'cancelled',
        reason: CancellationReason.ClientCancelled,
        completed_at: COMPLETED_AT,
      }),
    ).toMatchObject({ type: 'status', state: 'cancelled' });
  });

  it('posts the error message for a failed turn', () => {
    expect(buildDeliveryContent({ status: 'error', message: 'model timed out', completed_at: COMPLETED_AT })).toEqual({
      type: 'status',
      state: 'error',
      detail: 'The run failed: model timed out',
    });
  });
});
