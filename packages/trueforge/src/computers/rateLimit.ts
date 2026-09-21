/**
 * The guard on the two unauthenticated machine routes. Runtime-neutral: `undefined` means this
 * runtime offers no limiter, and the routes then run unguarded, which is what Node does today
 * because it serves no computers at all.
 */

/**
 * A 32-byte code is not guessable at any rate, so these are about what a flood costs us, not about
 * secrecy — and they have to leave room for a fleet of machines behind one address.
 */
export const ENROLL_ATTEMPTS_PER_WINDOW = 60;
export const CONNECT_ATTEMPTS_PER_WINDOW = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimiter {
  take(input: { key: string; limit: number; windowMs: number }): Promise<{ allowed: boolean; retry_after_ms: number }>;
}

/**
 * Cloudflare's edge always sets `CF-Connecting-IP`. Without it there is nothing to key on, and one
 * shared bucket would throttle every machine behind a proxy as though they were one attacker, so
 * the limit is skipped instead — which is also what makes it absent off Cloudflare entirely.
 */
export function rateLimitKey({ request, route }: { request: Request; route: string }): string | undefined {
  const address = request.headers.get('CF-Connecting-IP');
  if (address === null) {
    return undefined;
  }
  // An IPv6 client is given a /64 rather than a single address: one host there holds more
  // addresses than the whole of IPv4, so keying on the full one limits nothing.
  const bucket = address.includes(':') ? address.split(':').slice(0, 4).join(':') : address;
  return `${route}:${bucket}`;
}
