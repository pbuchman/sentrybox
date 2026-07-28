import { describe, expect, it } from "vitest";

import { redactValue } from "./index.js";

describe("redactValue", () => {
  it("removes sensitive keys and secret patterns before serialization", () => {
    const forbiddenValues = [
      "Bearer deeply-secret-token",
      "sk_live_0123456789abcdef",
      "https://public@example.ingest.sentry.io/42",
      "session=private-cookie",
      "person@example.com",
      "private preview text",
    ];
    const redacted = redactValue({
      authorization: forbiddenValues[0],
      apiKey: forbiddenValues[1],
      dsn: forbiddenValues[2],
      cookies: forbiddenValues[3],
      contact: forbiddenValues[4],
      contentPreview: forbiddenValues[5],
      nested: { password: "even-more-secret" },
      safe: "diagnostic context",
    });
    const serialized = JSON.stringify(redacted);

    for (const forbidden of forbiddenValues) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain("even-more-secret");
    expect(serialized).not.toContain("contentPreview");
    expect(redacted).toMatchObject({ safe: "diagnostic context" });
  });

  it("stops traversing data after eight nested levels", () => {
    const nested = nest("hidden", 9);

    expect(JSON.stringify(redactValue(nested))).not.toContain("hidden");
  });
});

function nest(value: string, depth: number): unknown {
  let current: unknown = value;
  for (let level = 0; level < depth; level += 1) {
    current = { level: current };
  }
  return current;
}
