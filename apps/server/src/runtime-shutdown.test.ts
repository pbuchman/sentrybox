import { describe, expect, it, vi } from "vitest";
import {
  createRetryableClose,
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

  it("shares an active close, stays idempotent after success, and retries after rejection", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const action = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstAttempt)
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const close = createRetryableClose(action);

    const first = close();
    const concurrent = close();
    expect(action).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(close()).resolves.toBeUndefined();
    expect(action).toHaveBeenCalledTimes(1);

    const retryAction = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const retryClose = createRetryableClose(retryAction);
    await expect(retryClose()).rejects.toThrow("cleanup failed");
    await expect(retryClose()).resolves.toBeUndefined();
    await expect(retryClose()).resolves.toBeUndefined();
    expect(retryAction).toHaveBeenCalledTimes(2);
  });
});
