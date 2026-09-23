import { describe, expect, it } from 'vitest';

import {
  ComputerDesktopError,
  createComputerDesktopServer,
  toTakeoverAnswer,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/computerDesktop.js';
import { createTrueForgeClient } from '@/plugins/trueforge-agent-server-adapter/client.js';
import type { DesktopStatus } from '@/server/types.js';

const wireStatus = {
  computer_id: 'computer-1',
  online: true,
  desktop: true,
  controller: { kind: 'human', user_id: 'user-1', is_me: true, expires_at: '2026-09-24T10:05:00.000Z' },
  pending_takeovers: [
    {
      session_id: 'session-1',
      turn_id: 'turn-1',
      tool_call_id: 'call-1',
      reason: 'Log in',
      requested_at: '2026-09-24T10:00:00.000Z',
      agent_id: 'agent-1',
    },
  ],
};

const uiStatus: DesktopStatus = {
  computerId: 'computer-1',
  online: true,
  desktop: true,
  controller: { kind: 'human', userId: 'user-1', isMe: true, expiresAt: '2026-09-24T10:05:00.000Z' },
  pendingTakeovers: [
    {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      reason: 'Log in',
      requestedAt: '2026-09-24T10:00:00.000Z',
      agentId: 'agent-1',
    },
  ],
};

type Recorded = { method: string; url: URL; body: string | null };

function serverWith(respond: (request: Recorded) => Response) {
  const requests: Recorded[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const recorded = { method: request.method, url: new URL(request.url), body: await request.text() };
    requests.push({ ...recorded, body: recorded.body === '' ? null : recorded.body });
    return respond(recorded);
  };
  const client = createTrueForgeClient({ baseUrl: 'http://tf.test', fetch: fetchMock });
  return { server: createComputerDesktopServer(client), requests };
}

describe('createComputerDesktopServer', () => {
  it('reads status for an agent as camelCase', async () => {
    const { server, requests } = serverWith(() => Response.json({ data: wireStatus }));
    await expect(server.getDesktopStatus({ computerId: 'computer-1', agentId: 'agent-1' })).resolves.toEqual(uiStatus);
    expect(requests[0]?.url.pathname).toBe('/api/v1/computer-desktops/computer-1');
    expect(requests[0]?.url.searchParams.get('agent_id')).toBe('agent-1');
  });

  it('returns frames as blobs', async () => {
    const { server, requests } = serverWith(
      () => new Response(new Uint8Array([0xff, 0xd8]), { headers: { 'content-type': 'image/jpeg' } }),
    );
    const frame = await server.getDesktopScreenshot({ computerId: 'computer-1' });
    expect(frame.size).toBe(2);
    expect(requests[0]?.url.pathname).toBe('/api/v1/computer-desktops/computer-1/screenshot');
    expect(requests[0]?.url.searchParams.has('agent_id')).toBe(false);
  });

  it('sends input actions and answers with the frame', async () => {
    const { server, requests } = serverWith(() => new Response(new Uint8Array([1, 2, 3])));
    const frame = await server.sendDesktopInput({
      computerId: 'computer-1',
      agentId: 'agent-1',
      actions: [
        { type: 'click', x: 10, y: 20, button: 'left', count: 1 },
        { type: 'key', keys: 'ctrl+l' },
      ],
    });
    expect(frame.size).toBe(3);
    expect(requests[0]?.method).toBe('POST');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      actions: [
        { type: 'click', x: 10, y: 20, button: 'left', count: 1 },
        { type: 'key', keys: 'ctrl+l' },
      ],
    });
  });

  it('turns a 423 into a desktop error carrying its code', async () => {
    const { server } = serverWith(() =>
      Response.json(
        { error: { message: 'Another person controls the desktop', code: 'human_in_control' } },
        { status: 423 },
      ),
    );
    const failure = await server.getDesktopScreenshot({ computerId: 'computer-1' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ComputerDesktopError);
    expect(failure).toMatchObject({
      statusCode: 423,
      code: 'human_in_control',
      message: 'Another person controls the desktop',
    });
  });

  it('does not retry a refused frame', async () => {
    const { server, requests } = serverWith(() =>
      Response.json({ error: { message: 'offline', code: 'offline' } }, { status: 503 }),
    );
    await expect(server.getDesktopScreenshot({ computerId: 'computer-1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'offline',
    });
    expect(requests).toHaveLength(1);
  });

  it('hands back naming the takeover and note', async () => {
    const { server, requests } = serverWith(() => Response.json({ data: wireStatus }));
    const answer = await server.handBackDesktop({
      computerId: 'computer-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      note: 'done',
    });
    expect(answer.status.computerId).toBe('computer-1');
    expect(requests[0]?.url.pathname).toBe('/api/v1/computer-desktops/computer-1/hand-back');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ session_id: 'session-1', note: 'done' });
  });
});

describe('toTakeoverAnswer', () => {
  it('reads the status and takeover outcome', () => {
    expect(
      toTakeoverAnswer({
        status: uiStatus,
        takeover: { sessionId: 'session-1', result: 'already_answered', message: 'Answered in chat' },
      }),
    ).toEqual({
      status: uiStatus,
      takeover: { sessionId: 'session-1', result: 'already_answered', message: 'Answered in chat' },
    });
  });

  it('reads a bare status as nothing to report', () => {
    expect(toTakeoverAnswer(uiStatus)).toEqual({ status: uiStatus, takeover: null });
  });

  it('ignores an outcome it does not know', () => {
    expect(toTakeoverAnswer({ status: uiStatus, takeover: { sessionId: 's', result: 'later', message: '' } })).toEqual({
      status: uiStatus,
      takeover: null,
    });
  });

  it('refuses an answer without a status', () => {
    expect(() => toTakeoverAnswer({ takeover: null })).toThrow('cannot read');
  });
});
