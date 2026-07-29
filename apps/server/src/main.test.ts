import { describe, expect, it } from "vitest";

describe("runtime entry point", () => {
  it("has no listener, environment, or signal side effects when imported", async () => {
    const before = signalListenerCounts();
    const previous = process.env.ERROR_HUB_ENV_FILE;
    delete process.env.ERROR_HUB_ENV_FILE;
    try {
      await expect(import("./main.js")).resolves.toMatchObject({
        runMain: expect.any(Function),
      });
      expect(signalListenerCounts()).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.ERROR_HUB_ENV_FILE;
      else process.env.ERROR_HUB_ENV_FILE = previous;
    }
  });
});

function signalListenerCounts() {
  return {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
}
