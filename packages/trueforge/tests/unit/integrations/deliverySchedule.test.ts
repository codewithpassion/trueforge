import {
  claimDeadlineAt,
  DELIVERY_RETRY_BASE_MS,
  DELIVERY_RETRY_MAX_BACKOFF_MS,
  DELIVERY_SENDING_TIMEOUT_MS,
  deliveryRetryBackoffMs,
  firstAttemptDueAt,
  nextAttemptAt,
} from '../../../src/integrations/deliverySchedule';

const NOW = 1_700_000_000_000;

describe('deliveryRetryBackoffMs', () => {
  it('doubles each attempt and stops at the ceiling', () => {
    expect(deliveryRetryBackoffMs(0)).toBe(DELIVERY_RETRY_BASE_MS);
    expect(deliveryRetryBackoffMs(1)).toBe(DELIVERY_RETRY_BASE_MS);
    expect(deliveryRetryBackoffMs(2)).toBe(DELIVERY_RETRY_BASE_MS * 2);
    expect(deliveryRetryBackoffMs(3)).toBe(DELIVERY_RETRY_BASE_MS * 4);
    expect(deliveryRetryBackoffMs(20)).toBe(DELIVERY_RETRY_MAX_BACKOFF_MS);
  });
});

describe('firstAttemptDueAt and claimDeadlineAt', () => {
  it('give the drain a head start, and a claim a deadline to finish in', () => {
    expect(firstAttemptDueAt(NOW).getTime()).toBe(NOW + DELIVERY_RETRY_BASE_MS);
    expect(claimDeadlineAt(NOW).getTime()).toBe(NOW + DELIVERY_SENDING_TIMEOUT_MS);
  });
});

describe('nextAttemptAt', () => {
  it("waits this attempt's backoff when the channel asked for nothing", () => {
    expect(nextAttemptAt({ attempts: 1, nowMs: NOW }).getTime()).toBe(NOW + DELIVERY_RETRY_BASE_MS);
    expect(nextAttemptAt({ attempts: 3, nowMs: NOW }).getTime()).toBe(NOW + DELIVERY_RETRY_BASE_MS * 4);
  });

  it('waits out a Retry-After longer than the backoff, so the next attempt is not refused too', () => {
    const retryAfterMs = 5 * 60_000;
    expect(nextAttemptAt({ attempts: 1, retryAfterMs, nowMs: NOW }).getTime()).toBe(NOW + retryAfterMs);
  });

  it('keeps the backoff when it is already longer than the requested pause', () => {
    expect(nextAttemptAt({ attempts: 4, retryAfterMs: 1_000, nowMs: NOW }).getTime()).toBe(
      NOW + DELIVERY_RETRY_BASE_MS * 8,
    );
  });

  it('never waits longer than the ceiling, whatever the channel asks for', () => {
    expect(nextAttemptAt({ attempts: 1, retryAfterMs: 60 * 60_000, nowMs: NOW }).getTime()).toBe(
      NOW + DELIVERY_RETRY_MAX_BACKOFF_MS,
    );
  });
});
