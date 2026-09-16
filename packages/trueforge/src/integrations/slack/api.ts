/** Slack Web API over `fetch`; no SDK, so the same code runs on Node and Workers. */
import { z } from 'zod';

const CHAT_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/**
 * A 429 is waited out in place while the pause stays short, because a message that arrives a
 * second late still reads as a reply. Anything longer goes back to the outbox, whose backoff
 * is measured in minutes.
 */
const RATE_LIMIT_WAIT_CAP_MS = 10_000;
const RATE_LIMIT_RETRIES = 2;
/** Slack omits `Retry-After` on some 429s; one second is its documented minimum. */
const DEFAULT_RETRY_AFTER_MS = 1_000;

/** Slack answers 200 with `ok: false` for logical failures, so the body decides, not the status. */
const SlackApiResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export type SlackPostResult = { ok: true } | { ok: false; error: string };

export interface SlackPostMessageInput {
  botToken: string;
  channel: string;
  threadTs: string;
  text: string;
  signal?: AbortSignal | undefined;
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

/**
 * Posts one message into a thread. The bot token only ever travels in the Authorization header —
 * failures are reported from Slack's own `error` code, never from the request.
 */
export async function postSlackMessage(
  input: SlackPostMessageInput & { fetchImpl?: SlackFetch },
): Promise<SlackPostResult> {
  const send = input.fetchImpl ?? fetch;
  const body = JSON.stringify({ channel: input.channel, thread_ts: input.threadTs, text: input.text });

  for (let attempt = 0; ; attempt += 1) {
    const response = await send(CHAT_POST_MESSAGE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (response.status !== 429) {
      return readResult(response);
    }
    const delay = retryAfterMs(response);
    if (attempt >= RATE_LIMIT_RETRIES || delay > RATE_LIMIT_WAIT_CAP_MS) {
      return { ok: false, error: `Slack rate limited the message; retry after ${String(Math.ceil(delay / 1000))}s` };
    }
    await wait(delay);
  }
}
