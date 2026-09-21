/** Slack Web API over `fetch`; no SDK, so the same code runs on Node and Workers. */
import { z } from 'zod';

const CHAT_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const AUTH_TEST_URL = 'https://slack.com/api/auth.test';

/**
 * A 429 is waited out in place while the pause stays short, because a message that arrives a
 * second late still reads as a reply. Anything longer goes back to the outbox, whose backoff
 * is measured in minutes.
 */
const RATE_LIMIT_WAIT_CAP_MS = 10_000;
const RATE_LIMIT_RETRIES = 2;
/** Slack omits `Retry-After` on some 429s; one second is its documented minimum. */
const DEFAULT_RETRY_AFTER_MS = 1_000;
/**
 * A hung connection must not outlive the claim that owns the row. Well under
 * `DELIVERY_SENDING_TIMEOUT_MS`, so the sweep never reclaims a post that is still in flight —
 * which would put the same message in the channel twice.
 */
export const SLACK_FETCH_TIMEOUT_MS = 30_000;

/** Slack answers 200 with `ok: false` for logical failures, so the body decides, not the status. */
const SlackApiResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export type SlackPostResult =
  | { ok: true }
  /** `retryAfterMs` is Slack's own requested pause, so the outbox can wait at least that long. */
  | { ok: false; error: string; retryAfterMs?: number };

export interface SlackPostMessageInput {
  botToken: string;
  channel: string;
  threadTs: string;
  text: string;
  /** Caller's own deadline, such as the alarm pass budget; the request timeout applies as well. */
  signal?: AbortSignal | undefined;
  /** Test seam for the request timeout. */
  timeoutMs?: number | undefined;
}

/** `fetch` is taken from the input so tests can drive the adapter without a global stub. */
export type SlackFetch = typeof fetch;

function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** An abort is a delivery failure to report, not a bug to throw; anything else still throws. */
function abortFailure(error: unknown, signal: AbortSignal | undefined): SlackPostResult {
  const name = error instanceof DOMException ? error.name : '';
  if (name !== 'TimeoutError' && name !== 'AbortError') {
    throw error;
  }
  return signal?.aborted === true
    ? { ok: false, error: 'Slack request was abandoned by its caller' }
    : { ok: false, error: 'Slack request timed out' };
}

async function readResult(response: Response): Promise<SlackPostResult> {
  if (!response.ok) {
    return { ok: false, error: `Slack API returned HTTP ${String(response.status)}` };
  }
  const parsed = SlackApiResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { ok: false, error: 'Slack API returned an unreadable body' };
  }
  if (parsed.data.ok) {
    return { ok: true };
  }
  return { ok: false, error: `Slack rejected the message: ${parsed.data.error ?? 'unknown_error'}` };
}

/** `auth.test` answers with the workspace and the bot's own user id for a valid bot token. */
const SlackAuthTestResponseSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
});

export type SlackAuthTestResult = { ok: true; team_id: string; bot_user_id: string } | { ok: false; error: string };

/** Injected wherever credentials are saved, so tests never reach slack.com. */
export type SlackAuthTest = (input: { botToken: string; fetchImpl?: SlackFetch }) => Promise<SlackAuthTestResult>;

/**
 * Identifies the workspace and bot behind a bot token, so nobody has to copy those ids by
 * hand. The token travels only in the Authorization header and is never part of a result.
 */
export const slackAuthTest: SlackAuthTest = async input => {
  const send = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(AUTH_TEST_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.botToken}`,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name !== 'TimeoutError' && name !== 'AbortError') {
      throw error;
    }
    return { ok: false, error: 'Slack did not answer auth.test in time' };
  }
  if (!response.ok) {
    return { ok: false, error: `Slack auth.test returned HTTP ${String(response.status)}` };
  }
  const body: unknown = await response.json();
  const parsed = SlackAuthTestResponseSchema.safeParse(body);
  if (parsed.success) {
    return { ok: true, team_id: parsed.data.team_id, bot_user_id: parsed.data.user_id };
  }
  const failure = SlackApiResponseSchema.safeParse(body);
  const reason = failure.success ? (failure.data.error ?? 'unknown_error') : 'unreadable_response';
  return { ok: false, error: `Slack rejected the bot token: ${reason}` };
};

/**
 * Posts one message into a thread. The bot token only ever travels in the Authorization header —
 * failures are reported from Slack's own `error` code, never from the request.
 */
export async function postSlackMessage(
  input: SlackPostMessageInput & { fetchImpl?: SlackFetch },
): Promise<SlackPostResult> {
  const send = input.fetchImpl ?? fetch;
  const body = JSON.stringify({ channel: input.channel, thread_ts: input.threadTs, text: input.text });
  const timeoutMs = input.timeoutMs ?? SLACK_FETCH_TIMEOUT_MS;

  for (let attempt = 0; ; attempt += 1) {
    if (input.signal?.aborted === true) {
      return { ok: false, error: 'Slack request was abandoned by its caller' };
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]);
    let response: Response;
    try {
      response = await send(CHAT_POST_MESSAGE_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body,
        signal,
      });
    } catch (error) {
      return abortFailure(error, input.signal);
    }
    if (response.status !== 429) {
      return readResult(response);
    }
    const delay = retryAfterMs(response);
    if (attempt >= RATE_LIMIT_RETRIES || delay > RATE_LIMIT_WAIT_CAP_MS) {
      return {
        ok: false,
        error: `Slack rate limited the message; retry after ${String(Math.ceil(delay / 1000))}s`,
        retryAfterMs: delay,
      };
    }
    await wait(delay);
  }
}
