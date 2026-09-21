/**
 * The guard on the two unauthenticated machine routes. Runtime-neutral: `undefined` means this
 * runtime offers no limiter, and the routes then run unguarded, which is what Node does today
 * because it serves no computers at all.
 */

/** Enrollment codes live fifteen minutes; a handful of tries per minute is generous for a machine. */
export const ENROLL_ATTEMPTS_PER_WINDOW = 10;
export const CONNECT_ATTEMPTS_PER_WINDOW = 30;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimiter {
  take(input: { key: string; limit: number; windowMs: number }): Promise<{ allowed: boolean; retry_after_ms: number }>;
}

/**
 * Cloudflare puts the caller's address in `CF-Connecting-IP`. Behind no proxy at all there is
 * nothing to key on, and one shared bucket is still better than none.
 */
export function rateLimitKey({ request, route }: { request: Request; route: string }): string {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return `${route}:${address}`;
}
