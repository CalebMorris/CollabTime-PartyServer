interface RateLimitEntry {
  attempts: number;
  windowStartMs: number;
  backoffUntilMs: number;
}

export class RateLimitService {
  private entries = new Map<string, RateLimitEntry>();
  private windowMs: number;
  private maxAttempts: number;
  private backoffAfter: number;

  constructor(options: { windowMs: number; maxAttempts: number; backoffAfter: number }) {
    this.windowMs = options.windowMs;
    this.maxAttempts = options.maxAttempts;
    this.backoffAfter = options.backoffAfter;
  }

  isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.entries.get(ip);
    if (!entry) return false;
    if (now < entry.backoffUntilMs) return true;
    if (now - entry.windowStartMs > this.windowMs) {
      this.entries.delete(ip);
      return false;
    }
    return entry.attempts > this.maxAttempts;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    let entry = this.entries.get(ip);
    if (!entry || now - entry.windowStartMs > this.windowMs) {
      entry = { attempts: 0, windowStartMs: now, backoffUntilMs: 0 };
      this.entries.set(ip, entry);
    }
    entry.attempts++;
    if (entry.attempts >= this.backoffAfter) {
      // Exponential backoff: 2^(attempts - backoffAfter) * 1000ms
      const backoffMs = Math.min(
        Math.pow(2, entry.attempts - this.backoffAfter) * 1000,
        300_000,
      );
      entry.backoffUntilMs = now + backoffMs;
    }
  }
}
