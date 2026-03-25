import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimitService } from '../../src/services/ratelimit.service.js';

describe('RateLimitService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not rate-limit a fresh IP with no failures', () => {
    const rl = new RateLimitService({ windowMs: 300_000, maxAttempts: 10, backoffAfter: 3 });
    expect(rl.isRateLimited('1.2.3.4')).toBe(false);
  });

  it('rate-limits an IP after backoffAfter failures', () => {
    const rl = new RateLimitService({ windowMs: 300_000, maxAttempts: 10, backoffAfter: 3 });
    const ip = '1.2.3.4';

    rl.recordFailure(ip); // 1
    rl.recordFailure(ip); // 2
    expect(rl.isRateLimited(ip)).toBe(false);

    rl.recordFailure(ip); // 3 — triggers backoff
    expect(rl.isRateLimited(ip)).toBe(true);
  });

  it('clears rate limit after backoff period expires', () => {
    const rl = new RateLimitService({ windowMs: 300_000, maxAttempts: 10, backoffAfter: 3 });
    const ip = '1.2.3.4';

    rl.recordFailure(ip); // 1
    rl.recordFailure(ip); // 2
    rl.recordFailure(ip); // 3 — backoff: 2^(3-3)*1000 = 1000ms

    expect(rl.isRateLimited(ip)).toBe(true);

    vi.advanceTimersByTime(1001);
    expect(rl.isRateLimited(ip)).toBe(false);
  });

  it('resets window after windowMs elapses', () => {
    const rl = new RateLimitService({ windowMs: 300_000, maxAttempts: 10, backoffAfter: 3 });
    const ip = '1.2.3.4';

    // Record enough failures to exceed maxAttempts in next window
    for (let i = 0; i < 11; i++) rl.recordFailure(ip);

    // Advance past the window
    vi.advanceTimersByTime(300_001);
    expect(rl.isRateLimited(ip)).toBe(false);
  });

  it('only ROOM_NOT_FOUND and ROOM_FULL errors should increment counter (documented behavior)', () => {
    // This test verifies the architectural contract: rate limiting applies
    // to join errors, not reconnect errors. The service itself is agnostic —
    // callers are responsible for only calling recordFailure on the right errors.
    // We verify the service correctly tracks counts.
    const rl = new RateLimitService({ windowMs: 300_000, maxAttempts: 10, backoffAfter: 3 });
    const ip = '1.2.3.4';

    // Simulating that caller records ROOM_NOT_FOUND / ROOM_FULL
    rl.recordFailure(ip);
    rl.recordFailure(ip);
    rl.recordFailure(ip);
    expect(rl.isRateLimited(ip)).toBe(true);
  });

  it('rate-limits at exactly maxAttempts failures (no backoff path)', () => {
    // backoffAfter set higher than maxAttempts so backoff never triggers — tests the maxAttempts guard alone
    const rl = new RateLimitService({ windowMs: 300_000, maxAttempts: 5, backoffAfter: 999 });
    const ip = '9.9.9.9';

    for (let i = 0; i < 5; i++) rl.recordFailure(ip);
    expect(rl.isRateLimited(ip)).toBe(true);
  });

  it('exponential backoff increases with more failures', () => {
    const rl = new RateLimitService({ windowMs: 300_000, maxAttempts: 10, backoffAfter: 3 });
    const ip = '1.2.3.4';

    // 3 failures → backoff 1s (2^0 * 1000)
    rl.recordFailure(ip);
    rl.recordFailure(ip);
    rl.recordFailure(ip);

    vi.advanceTimersByTime(1001);
    expect(rl.isRateLimited(ip)).toBe(false);

    // 4th failure → backoff 2s (2^1 * 1000)
    rl.recordFailure(ip);
    expect(rl.isRateLimited(ip)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(rl.isRateLimited(ip)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(rl.isRateLimited(ip)).toBe(false);
  });
});
