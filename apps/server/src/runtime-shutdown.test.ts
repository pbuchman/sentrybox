import { describe, expect, it, vi } from "vitest";
import {
  createIdempotentClose,
  runBoundedShutdown,
  RuntimeShutdownError,
  type RuntimeShutdownActions,
} from "./runtime.js";

describe("bounded runtime shutdown", () => {
  it("attempts every cleanup after failures and reports them only after private and database close", async () => {
    const calls: string[] = [];
    const failure = (name: string) => async (): Promise<void> => {
      calls.push(name);
      throw new Error(`${name} failed`);
    };
    const actions: RuntimeShutdownActions = {
      stopPublicIngress: failure("public"),
      forceStopPublicIngress: () => {
        calls.push("public-force");
        throw new Error("public force failed");
      },
      abortLoops: () => {
        calls.push("abort");
        throw new Error("abort failed");
      },
      drainShadow: failure("shadow"),
      drainOutbox: failure("outbox"),
      closeLoops: failure("loops"),
      checkpointWal: () => {
        calls.push("checkpoint");
        throw new Error("checkpoint failed");
      },
      closePrivateListener: failure("private"),
      forceStopPrivateListener: () => {
        calls.push("private-force");
        throw new Error("private force failed");
      },
      closeDatabase: () => {
        calls.push("database");
        throw new Error("database failed");
      },
    };

    const rejection = await runBoundedShutdown(actions, 100).catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(RuntimeShutdownError);
    expect((rejection as RuntimeShutdownError).message).toBe(
      "SentryBox shutdown did not complete cleanly",
    );
    expect((rejection as RuntimeShutdownError).errors).toHaveLength(10);
    expect(calls).toEqual([
      "public",
      "public-force",
      "abort",
      "shadow",
      "outbox",
      "loops",
      "checkpoint",
      "private",
      "private-force",
      "database",
    ]);
  });

  it("bounds hanging actions while still aborting loops and closing private listener and database", async () => {
    const calls: string[] = [];
    const hanging = () => new Promise<void>(() => undefined);
    const started = Date.now();
    const actions: RuntimeShutdownActions = {
      stopPublicIngress: async () => {
        calls.push("public");
      },
      forceStopPublicIngress: () => calls.push("public-force"),
      abortLoops: () => calls.push("abort"),
      drainShadow: async () => {
        calls.push("shadow");
        await hanging();
      },
      drainOutbox: async () => {
        calls.push("outbox");
        throw new Error("outbox failed");
      },
      closeLoops: async () => {
        calls.push("loops");
        await hanging();
      },
      checkpointWal: () => calls.push("checkpoint"),
      closePrivateListener: async () => {
        calls.push("private");
        await hanging();
      },
      forceStopPrivateListener: () => calls.push("private-force"),
      closeDatabase: () => calls.push("database"),
    };

    await expect(runBoundedShutdown(actions, 80)).rejects.toBeInstanceOf(
      RuntimeShutdownError,
    );

    expect(Date.now() - started).toBeLessThan(300);
    expect(calls[0]).toBe("public");
    expect(calls).toEqual([
      "public",
      "abort",
      "shadow",
      "outbox",
      "loops",
      "checkpoint",
      "private",
      "private-force",
      "database",
    ]);
  });

  it("shares one close attempt and replays its exact success or rejection", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const action = vi.fn<() => Promise<void>>().mockReturnValue(firstAttempt);
    const close = createIdempotentClose(action);

    const first = close();
    const concurrent = close();
    expect(concurrent).toBe(first);
    expect(action).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    const afterSuccess = close();
    expect(afterSuccess).toBe(first);
    await expect(afterSuccess).resolves.toBeUndefined();
    expect(action).toHaveBeenCalledTimes(1);

    const failure = new Error("cleanup failed");
    const failedAction = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(failure);
    const failedClose = createIdempotentClose(failedAction);
    const firstFailure = failedClose();
    const concurrentFailure = failedClose();
    expect(concurrentFailure).toBe(firstFailure);
    await expect(firstFailure).rejects.toBe(failure);
    const afterFailure = failedClose();
    expect(afterFailure).toBe(firstFailure);
    await expect(afterFailure).rejects.toBe(failure);
    expect(failedAction).toHaveBeenCalledTimes(1);
  });
});
