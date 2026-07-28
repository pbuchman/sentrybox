import { describe, expect, it } from "vitest";
import { ConcurrencyGate, FixedWindowRateLimiter } from "./rate-limit.js";

describe("ingest abuse guards", () => {
  it("enforces and expires independent fixed-window keys", () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);

    expect(limiter.consume("source:a", 1_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 60,
    });
    expect(limiter.consume("source:a", 2_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 59,
    });
    expect(limiter.consume("source:a", 3_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 58,
    });
    expect(limiter.consume("source:b", 3_000).allowed).toBe(true);
    expect(limiter.consume("source:a", 61_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 60,
    });
  });

  it("releases a concurrency slot exactly once", () => {
    const gate = new ConcurrencyGate(1);
    const release = gate.tryAcquire();

    expect(release).toBeTypeOf("function");
    expect(gate.tryAcquire()).toBeNull();
    release?.();
    release?.();
    expect(gate.tryAcquire()).toBeTypeOf("function");
  });
});
