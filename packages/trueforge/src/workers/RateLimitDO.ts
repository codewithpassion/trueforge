import { DurableObject } from 'cloudflare:workers';

/**
 * A fixed-window counter, one object per key. Deliberately small: the machine routes are the only
 * unauthenticated surface on the server, and a guess at an enrollment code or a credential should
 * cost the guesser more than it costs us.
 *
 * Fixed window rather than a sliding one because the state is a single number and an alarm: a
 * burst at a window boundary can reach twice the limit, which for a brute-force guard is noise.
 */
export class RateLimitDO extends DurableObject {
  /**
   * Counts this attempt and says whether it is allowed. The window starts at the first attempt and
   * is dropped by an alarm, so an idle key costs no storage.
   */
  async take(input: { limit: number; windowMs: number }): Promise<{ allowed: boolean; retry_after_ms: number }> {
    const now = Date.now();
    const startedAt = (await this.ctx.storage.get<number>('window_started_at')) ?? 0;
    const elapsed = now - startedAt;
    const count = elapsed >= input.windowMs ? 0 : ((await this.ctx.storage.get<number>('count')) ?? 0);
    if (count === 0) {
      await this.ctx.storage.put('window_started_at', now);
      // Lets the object forget an idle key instead of holding a counter for it forever.
      await this.ctx.storage.setAlarm(now + input.windowMs);
    }
    const next = count + 1;
    await this.ctx.storage.put('count', next);
    const windowStartedAt = count === 0 ? now : startedAt;
    return {
      allowed: next <= input.limit,
      retry_after_ms: Math.max(0, windowStartedAt + input.windowMs - now),
    };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
