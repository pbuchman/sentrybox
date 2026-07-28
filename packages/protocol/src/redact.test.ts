import { describe, expect, it } from "vitest";

import { redactValue } from "./index.js";
import { redactString } from "./redact.js";

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

  it("redacts generic auth schemes and complete cookie expressions", () => {
    const forbiddenValues = [
      "Basic dXNlcjpwYXNzd29yZA==",
      "Digest username=alice, response=secret-digest",
      "Bearer auth-token",
      "first=one; forbidden-cookie=two; third=three",
    ];
    const serialized = JSON.stringify(
      redactValue({
        auth: forbiddenValues[0],
        authentication: forbiddenValues[1],
        detail: `authorization: ${forbiddenValues[2]}`,
        cookieDetail: `Cookie: ${forbiddenValues[3]}`,
      }),
    );

    for (const forbidden of forbiddenValues) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain("forbidden-cookie=two");
  });

  it("keeps prototype-sensitive keys as inert own properties", () => {
    const result = redactValue({
      __proto__: "safe-proto",
      constructor: "safe-constructor",
      prototype: "safe-prototype",
    });

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(JSON.stringify(result)).toContain("safe-constructor");
    expect(JSON.stringify(result)).toContain("safe-prototype");
  });

  it("redacts credential-bearing Basic and Digest schemes without erasing ordinary diagnostics", () => {
    const basicCredential = "Basic dXNlcjpwYXNzd29yZA==";
    const digestCredential = "Digest username=alice, response=secret-digest";
    const serialized = JSON.stringify(
      redactValue({ basic: basicCredential, digest: digestCredential }),
    );

    expect(serialized).not.toContain(basicCredential);
    expect(serialized).not.toContain(digestCredential);
    expect(redactString("Basic validation failed")).toBe(
      "Basic validation failed",
    );
    expect(redactString("digest calculation failed")).toBe(
      "digest calculation failed",
    );
  });

  it("uses decoded Basic and canonical Digest parameters instead of token heuristics", () => {
    const paddedBasic = "Basic dXNlcjpwYXNzd29yZA==";
    const unpaddedBasic = "Basic YWFhOmJi";
    const freeTextDigest =
      "Digest username=alice, realm=example, response=secret-response";
    const authorizationDigest =
      'Authorization: Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b", uri="/dir/index.html", response="6629fae"';

    for (const credential of [
      paddedBasic,
      unpaddedBasic,
      freeTextDigest,
      authorizationDigest,
    ]) {
      expect(redactString(credential)).not.toContain(credential);
    }

    expect(redactString("Basic workflow2 failed")).toBe(
      "Basic workflow2 failed",
    );
    expect(redactString("Digest response=slow operation failed")).toBe(
      "Digest response=slow operation failed",
    );
    expect(redactString("Basic YWFhOmJ")).toBe("Basic YWFhOmJ");
    expect(redactString("Basic !!!not-base64!!!")).toBe(
      "Basic !!!not-base64!!!",
    );
  });
});

function nest(value: string, depth: number): unknown {
  let current: unknown = value;
  for (let level = 0; level < depth; level += 1) {
    current = { level: current };
  }
  return current;
}
