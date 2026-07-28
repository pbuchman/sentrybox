import { describe, expect, it } from "vitest";
import { loadPublicServerConfig } from "./config.js";

describe("public server configuration", () => {
  it("loads bounded defaults and the credential-file location", () => {
    expect(
      loadPublicServerConfig({
        ERROR_HUB_ENV_FILE: "/run/secrets/error-hub",
      }),
    ).toEqual({
      envFile: "/run/secrets/error-hub",
      requestTimeoutMs: 10_000,
      globalRateLimit: 5_000,
      sourceRateLimit: 120,
      maxSourceKeys: 10_000,
      projectRateLimit: 1_000,
      rateWindowMs: 60_000,
      retryAfterSeconds: 60,
      maxConcurrentParses: 16,
      shadowQueueCapacity: 100,
      shadowConcurrency: 2,
    });
  });

  it("accepts explicit positive safe-integer guard values", () => {
    expect(
      loadPublicServerConfig({
        ERROR_HUB_ENV_FILE: "/run/secrets/error-hub",
        ERROR_HUB_INGEST_REQUEST_TIMEOUT_MS: "2500",
        ERROR_HUB_INGEST_GLOBAL_RATE_LIMIT: "2000",
        ERROR_HUB_INGEST_SOURCE_RATE_LIMIT: "20",
        ERROR_HUB_INGEST_MAX_SOURCE_KEYS: "500",
        ERROR_HUB_INGEST_PROJECT_RATE_LIMIT: "200",
        ERROR_HUB_INGEST_RATE_WINDOW_MS: "30000",
        ERROR_HUB_INGEST_RETRY_AFTER_SECONDS: "30",
        ERROR_HUB_INGEST_MAX_CONCURRENT_PARSES: "4",
        ERROR_HUB_SHADOW_QUEUE_CAPACITY: "8",
        ERROR_HUB_SHADOW_CONCURRENCY: "1",
      }),
    ).toMatchObject({
      requestTimeoutMs: 2_500,
      globalRateLimit: 2_000,
      sourceRateLimit: 20,
      maxSourceKeys: 500,
      projectRateLimit: 200,
      rateWindowMs: 30_000,
      retryAfterSeconds: 30,
      maxConcurrentParses: 4,
      shadowQueueCapacity: 8,
      shadowConcurrency: 1,
    });
  });

  it.each([
    ["ERROR_HUB_INGEST_REQUEST_TIMEOUT_MS", "0"],
    ["ERROR_HUB_INGEST_GLOBAL_RATE_LIMIT", "0"],
    ["ERROR_HUB_INGEST_SOURCE_RATE_LIMIT", "-1"],
    ["ERROR_HUB_INGEST_MAX_SOURCE_KEYS", "0"],
    ["ERROR_HUB_INGEST_PROJECT_RATE_LIMIT", "1.5"],
    ["ERROR_HUB_INGEST_RATE_WINDOW_MS", "NaN"],
    ["ERROR_HUB_INGEST_RETRY_AFTER_SECONDS", "9007199254740992"],
    ["ERROR_HUB_INGEST_MAX_CONCURRENT_PARSES", ""],
    ["ERROR_HUB_SHADOW_QUEUE_CAPACITY", "value"],
    ["ERROR_HUB_SHADOW_CONCURRENCY", "0"],
  ])("rejects invalid %s=%s", (name, value) => {
    expect(() =>
      loadPublicServerConfig({
        ERROR_HUB_ENV_FILE: "/run/secrets/error-hub",
        [name]: value,
      }),
    ).toThrow(name);
  });
});
