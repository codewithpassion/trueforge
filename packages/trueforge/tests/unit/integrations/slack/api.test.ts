import { postSlackMessage, slackAuthTest } from '../../../../src/integrations/slack/api';

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
      // The outbox waits this out rather than earning a second refusal at its own backoff.
      retryAfterMs: 60_000,
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

describe('postSlackMessage deadlines', () => {
  /** Never settles on its own, so only the request's own signal can end it. */
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
      });
    });

  it('gives up on a connection that never answers', async () => {
    // Without this the request would inherit the runtime's own default, which outlasts the
    // claim that owns the row — long enough for the sweep to post the same message again.
    const result = await postSlackMessage({ ...INPUT, fetchImpl: hangingFetch, timeoutMs: 50 });

    expect(result).toEqual({ ok: false, error: 'Slack request timed out' });
  });

  it("stops when the caller's own deadline passes", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 20);

    const result = await postSlackMessage({
      ...INPUT,
      fetchImpl: hangingFetch,
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    expect(result).toEqual({ ok: false, error: 'Slack request was abandoned by its caller' });
  });

  it('does not call out at all once the caller is already out of time', async () => {
    const { fetchImpl, calls } = fakeFetch([okResponse()]);
    const controller = new AbortController();
    controller.abort();

    expect(await postSlackMessage({ ...INPUT, fetchImpl, signal: controller.signal })).toEqual({
      ok: false,
      error: 'Slack request was abandoned by its caller',
    });
    expect(calls).toEqual([]);
  });

  it('still throws a failure that is not an abort', async () => {
    const broken: typeof fetch = () => Promise.reject(new TypeError('network is unreachable'));

    await expect(postSlackMessage({ ...INPUT, fetchImpl: broken })).rejects.toThrow('network is unreachable');
  });
});

describe('slackAuthTest', () => {
  /** `auth.test` sends no JSON body, so the shared recorder's body parse cannot be reused. */
  function authFetch(response: Response | (() => never)): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get('authorization'), body: init?.body ?? null });
      return typeof response === 'function' ? response() : response;
    };
    return { fetchImpl, calls };
  }

  it('reads the workspace and the bot user id, with the token only in the header', async () => {
    const { fetchImpl, calls } = authFetch(
      Response.json({ ok: true, team_id: 'T0TEAM', user_id: 'U0BOT', bot_id: 'B0BOT' }),
    );

    expect(await slackAuthTest({ botToken: 'xoxb-secret-token', fetchImpl })).toEqual({
      ok: true,
      team_id: 'T0TEAM',
      bot_user_id: 'U0BOT',
    });
    expect(calls[0]?.url).toBe('https://slack.com/api/auth.test');
    expect(calls[0]?.authorization).toBe('Bearer xoxb-secret-token');
    expect(calls[0]?.body).toBeNull();
  });

  it('refuses a user token, which carries no bot_id', async () => {
    // `xoxp-` answers ok with a person's user_id; storing that as the bot would make the
    // adapter read everything that person says as its own and ignore it.
    const { fetchImpl } = authFetch(Response.json({ ok: true, team_id: 'T0TEAM', user_id: 'U0HUMAN' }));

    expect(await slackAuthTest({ botToken: 'xoxp-user-token', fetchImpl })).toEqual({
      ok: false,
      kind: 'rejected',
      error: 'That is not a bot token; use the bot user OAuth token, which starts with xoxb-',
    });
  });

  it.each(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'])(
    'reports %s as a credential the caller must fix',
    async code => {
      const { fetchImpl } = authFetch(Response.json({ ok: false, error: code }));

      const result = await slackAuthTest({ botToken: 'xoxb-secret-token', fetchImpl });
      expect(result).toEqual({ ok: false, kind: 'rejected', error: `Slack rejected the bot token: ${code}` });
      expect(JSON.stringify(result)).not.toContain('xoxb-secret-token');
    },
  );

  it('treats an unrecognised Slack error as Slack being unavailable', async () => {
    const { fetchImpl } = authFetch(Response.json({ ok: false, error: 'internal_error' }));

    expect(await slackAuthTest({ botToken: 'xoxb-secret-token', fetchImpl })).toEqual({
      ok: false,
      kind: 'unavailable',
      error: 'Slack rejected the bot token: internal_error',
    });
  });

  it('reports an HTTP failure as unavailable', async () => {
    const { fetchImpl } = authFetch(new Response('', { status: 503 }));

    expect(await slackAuthTest({ botToken: 'xoxb-secret-token', fetchImpl })).toEqual({
      ok: false,
      kind: 'unavailable',
      error: 'Slack auth.test returned HTTP 503',
    });
  });

  it('reports a 200 that is not JSON as unavailable', async () => {
    const { fetchImpl } = authFetch(new Response('<html>502</html>', { status: 200 }));

    expect(await slackAuthTest({ botToken: 'xoxb-secret-token', fetchImpl })).toMatchObject({
      ok: false,
      kind: 'unavailable',
      error: expect.stringContaining('unreadable'),
    });
  });

  it('reports a timeout as unavailable rather than throwing', async () => {
    const { fetchImpl } = authFetch(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });

    expect(await slackAuthTest({ botToken: 'xoxb-secret-token', fetchImpl })).toMatchObject({
      ok: false,
      kind: 'unavailable',
      error: 'Slack did not answer auth.test in time',
    });
  });

  it('reports a network failure as unavailable and keeps the original error as the cause', async () => {
    const broken = new TypeError('network is unreachable');
    const fetchImpl: typeof fetch = () => Promise.reject(broken);

    expect(await slackAuthTest({ botToken: 'xoxb-secret-token', fetchImpl })).toEqual({
      ok: false,
      kind: 'unavailable',
      error: 'Slack auth.test could not be reached',
      cause: broken,
    });
  });
});
