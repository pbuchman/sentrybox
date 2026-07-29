export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface WindowCounter {
  count: number;
  expiresAt: number;
}

interface FixedWindowRateLimiterOptions {
  readonly maxKeys?: number;
  readonly cleanupBudget?: number;
}

export class FixedWindowRateLimiter {
  readonly #counters = new Map<string, WindowCounter>();
  readonly #maxKeys: number;
  readonly #cleanupBudget: number;

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    options: FixedWindowRateLimiterOptions = {},
  ) {
    assertPositiveInteger(limit, "rate limit");
    assertPositiveInteger(windowMs, "rate window");
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#cleanupBudget = options.cleanupBudget ?? 16;
    assertPositiveInteger(this.#maxKeys, "maximum rate-limit keys");
    assertPositiveInteger(this.#cleanupBudget, "rate-limit cleanup budget");
  }

  public get cardinality(): number {
    return this.#counters.size;
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
      if (this.#counters.size >= this.#maxKeys) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(this.windowMs / 1_000),
        };
      }
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
    let inspected = 0;
    for (const [key, counter] of this.#counters) {
      if (inspected >= this.#cleanupBudget) break;
      inspected += 1;
      if (counter.expiresAt > now) break;
      this.#counters.delete(key);
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
