import { postSlackMessage } from '../../../../src/integrations/slack/api';

interface Call {
  url: string;
  authorization: string | null;
  body: unknown;
}

/** Replays the given responses in order and records what was sent. */
function fakeFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get('authorization'),
      body: JSON.parse(String(init?.body)),
    });
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(`no scripted response for call ${String(calls.length)}`);
    }
    return response;
  };
  return { fetchImpl, calls };
}

function okResponse(): Response {
  return Response.json({ ok: true, ts: '1700000000.000200' });
}

function rateLimited(retryAfterSeconds: string): Response {
  return new Response('', { status: 429, headers: { 'retry-after': retryAfterSeconds } });
}

const INPUT = {
  botToken: 'xoxb-secret-token',
  channel: 'C0GENERAL',
  threadTs: '1700000000.000100',
  text: 'hello',
};

describe('postSlackMessage', () => {
  it('posts into the thread with the token in the Authorization header only', async () => {
    const { fetchImpl, calls } = fakeFetch([okResponse()]);

    expect(await postSlackMessage({ ...INPUT, fetchImpl })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]?.authorization).toBe('Bearer xoxb-secret-token');
    expect(calls[0]?.body).toEqual({ channel: 'C0GENERAL', thread_ts: '1700000000.000100', text: 'hello' });
  });

  it('reports a logical failure from the body, not the status', async () => {
    const { fetchImpl } = fakeFetch([Response.json({ ok: false, error: 'channel_not_found' })]);

    expect(await postSlackMessage({ ...INPUT, fetchImpl })).toEqual({
      ok: false,
      error: 'Slack rejected the message: channel_not_found',
    });
  });

  it('reports a transport failure by status', async () => {
    const { fetchImpl } = fakeFetch([new Response('nope', { status: 502 })]);

    expect(await postSlackMessage({ ...INPUT, fetchImpl })).toEqual({
      ok: false,
      error: 'Slack API returned HTTP 502',
    });
  });

  it('waits out a short Retry-After and posts again', async () => {
    const { fetchImpl, calls } = fakeFetch([rateLimited('1'), okResponse()]);
    const started = Date.now();

    expect(await postSlackMessage({ ...INPUT, fetchImpl })).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('hands a long Retry-After back to the outbox instead of holding the request', async () => {
    const { fetchImpl, calls } = fakeFetch([rateLimited('60')]);
    const started = Date.now();

    expect(await postSlackMessage({ ...INPUT, fetchImpl })).toEqual({
      ok: false,
      error: 'Slack rate limited the message; retry after 60s',
    });
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('gives up after its in-place retries are spent', async () => {
    const { fetchImpl, calls } = fakeFetch([rateLimited('0'), rateLimited('0'), rateLimited('0')]);

    expect(await postSlackMessage({ ...INPUT, fetchImpl })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(3);
  });
});
