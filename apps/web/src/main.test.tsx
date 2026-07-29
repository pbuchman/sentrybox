import { expect, it } from "vitest";

it("identifies a missing SentryBox root element", async () => {
  document.body.innerHTML = "";

  await expect(import("./main.js")).rejects.toThrow(
    "SentryBox root element is missing",
  );
});
