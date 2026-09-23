/**
 * A `tool.response` with an image part crosses the SDK twice: the session event list and the live
 * turn stream. Both must hand the runtime camelCase parts, with the image reference intact.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createHarnessChatServer } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';

const wireToolResponse = {
  type: 'tool.response',
  id: 'evt_tool',
  thread_id: 'main',
  tool_call_id: 'call_1',
  created_at: '2026-09-24T00:00:00.000Z',
  content: [
    { type: 'text', text: 'clicked' },
    { type: 'image', file_id: 'a'.repeat(32), media_type: 'image/jpeg', width: 1280, height: 800 },
  ],
};

const uiToolResponse = {
  type: 'tool.response',
  id: 'evt_tool',
  threadId: 'main',
  toolCallId: 'call_1',
  createdAt: '2026-09-24T00:00:00.000Z',
  content: [
    { type: 'text', text: 'clicked' },
    { type: 'image', fileId: 'a'.repeat(32), mediaType: 'image/jpeg', width: 1280, height: 800 },
  ],
};

const fetchMock: typeof fetch = async input => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/api/v1/sessions/ses_1/events')) {
    return Response.json({ data: [{ turn_id: 'trn_1', event: wireToolResponse }], pagination: { limit: 50 } });
  }
  if (url.includes('/api/v1/sessions/ses_1/turns/trn_1/subscribe')) {
    return new Response(`id: 3\ndata: ${JSON.stringify(wireToolResponse)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(`Unexpected request: ${url}`, { status: 500 });
};

describe('image tool.response through the SDK', () => {
  it('lists it with camelCase image parts', async () => {
    const server = createHarnessChatServer({ fetch: fetchMock });
    assert.ok(server.listEvents);

    const page = await server.listEvents({ sessionId: 'ses_1' });

    assert.deepEqual(page.data, [{ turnId: 'trn_1', event: uiToolResponse }]);
  });

  it('streams it with camelCase image parts', async () => {
    const server = createHarnessChatServer({ fetch: fetchMock });
    assert.ok(server.subscribeToTurn);

    const events = [];
    for await (const item of server.subscribeToTurn({ sessionId: 'ses_1', turnId: 'trn_1' })) {
      events.push(item.event);
    }

    assert.deepEqual(events, [uiToolResponse]);
  });
});
