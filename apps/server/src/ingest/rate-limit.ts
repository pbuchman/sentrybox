export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface WindowCounter {
  count: number;
  expiresAt: number;
}

export class FixedWindowRateLimiter {
  readonly #counters = new Map<string, WindowCounter>();

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    assertPositiveInteger(limit, "rate limit");
    assertPositiveInteger(windowMs, "rate window");
  }

  public consume(key: string, now: number): RateLimitDecision {
    if (key.length === 0) {
      throw new TypeError("rate-limit key must not be empty");
    }
    if (!Number.isFinite(now)) {
      throw new TypeError("rate-limit timestamp must be finite");
    }
    this.removeExpired(now);
    const current = this.#counters.get(key);
    if (current === undefined) {
      this.#counters.set(key, { count: 1, expiresAt: now + this.windowMs });
      return {
        allowed: true,
        retryAfterSeconds: Math.ceil(this.windowMs / 1_000),
      };
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.expiresAt - now) / 1_000),
    );
    if (current.count >= this.limit) {
      return { allowed: false, retryAfterSeconds };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds };
  }

  private removeExpired(now: number): void {
    for (const [key, counter] of this.#counters) {
      if (counter.expiresAt <= now) {
        this.#counters.delete(key);
      }
    }
  }
}

export class ConcurrencyGate {
  #active = 0;

  public constructor(private readonly maximum: number) {
    assertPositiveInteger(maximum, "maximum concurrency");
  }

  public tryAcquire(): (() => void) | null {
    if (this.#active >= this.maximum) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}
