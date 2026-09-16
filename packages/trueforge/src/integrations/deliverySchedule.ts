/**
 * When an outbox row is next owed. Every writer stamps `next_attempt_at` from here, so the
 * sweep can read due rows in due order instead of re-deriving a deadline per status.
 */

/** How many posts one reply is worth before the outbox row is given up on. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** Backoff for the first retry; each further attempt doubles it. */
export const DELIVERY_RETRY_BASE_MS = 30 * 1000;
export const DELIVERY_RETRY_MAX_BACKOFF_MS = 15 * 60 * 1000;
/**
 * How long a claim has to finish in. It only has to outlast one post, whose own request timeout
 * is well under this, so a reclaim cannot overlap a post that is still in flight.
 */
export const DELIVERY_SENDING_TIMEOUT_MS = 5 * 60 * 1000;

export function deliveryRetryBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(DELIVERY_RETRY_BASE_MS * 2 ** exponent, DELIVERY_RETRY_MAX_BACKOFF_MS);
}

/**
 * When a fresh row becomes the sweep's. The turn's own drain normally delivers long before
 * this; the wait is what keeps the sweep from racing it for the common case.
 */
export function firstAttemptDueAt(nowMs: number = Date.now()): Date {
  return new Date(nowMs + DELIVERY_RETRY_BASE_MS);
}

/** The deadline a claim has to finish in; past it the sweep treats the row as stranded. */
export function claimDeadlineAt(nowMs: number = Date.now()): Date {
  return new Date(nowMs + DELIVERY_SENDING_TIMEOUT_MS);
}

/**
 * When the next attempt becomes due after a failure: this caller's backoff, or a longer pause
 * the channel asked for — retrying inside a `Retry-After` window only earns another refusal.
 */
export function nextAttemptAt(input: { attempts: number; retryAfterMs?: number | undefined; nowMs?: number }): Date {
  const wait = Math.max(deliveryRetryBackoffMs(input.attempts), input.retryAfterMs ?? 0);
  return new Date((input.nowMs ?? Date.now()) + Math.min(wait, DELIVERY_RETRY_MAX_BACKOFF_MS));
}
