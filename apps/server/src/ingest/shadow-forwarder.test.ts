import { describe, expect, it, vi } from "vitest";
import type { VerifiedIngestKey } from "../storage/project-repository.js";
import {
  createShadowForwarder,
  type ShadowForwardMetric,
  type ShadowHttpRequest,
} from "./shadow-forwarder.js";

const ENVELOPE = Buffer.from(
  '{"event_id":"11111111111111111111111111111111"}\n{"type":"event"}\n{"event_id":"11111111111111111111111111111111"}',
);
const LEGACY_DEV_DSN = "https://legacy-dev-key@o1.ingest.sentry.io/9";
const LEGACY_PROD_DSN =
  "https://legacy-prod-key:legacy-secret@o2.ingest.sentry.io/prefix/10";

describe("bounded migration shadow forwarder", () => {
  it("rewrites only the verified legacy transport target and preserves envelope bytes", async () => {
    const sent: ShadowHttpRequest[] = [];
    const metrics: ShadowForwardMetric[] = [];
    const forwarder = createShadowForwarder({
      secretResolver: secretResolver({
        LEGACY_DEV_DSN,
      }),
      send: async (request) => {
        sent.push(request);
        return { statusCode: 200 };
      },
      onMetric: (metric) => metrics.push(metric),
      queueCapacity: 4,
      concurrency: 1,
      now: incrementalClock(),
    });

    expect(
      forwarder.enqueue(
        shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "dev"),
      ),
    ).toBe("queued");
    await waitFor(() => sent.length === 1 && metrics.length === 1);

    expect(sent[0]?.url.href).toBe(
      "https://o1.ingest.sentry.io/api/9/envelope/?sentry_version=7&sentry_key=legacy-dev-key&sentry_client=sentry.javascript.node%2F8.55.0",
    );
    expect(sent[0]?.headers).toEqual({
      "content-encoding": "gzip",
      "content-type": "application/x-sentry-envelope",
    });
    expect(sent[0]?.body).toEqual(ENVELOPE);
    expect(sent[0]?.body).not.toBe(ENVELOPE);
    expect(metrics).toEqual([
      {
        outcome: "success",
        environment: "dev",
        durationMs: 1,
        statusCode: 200,
      },
    ]);
  });

  it("selects distinct fixed targets only from each verified environment-bound key", async () => {
    const sent: ShadowHttpRequest[] = [];
    const forwarder = createShadowForwarder({
      secretResolver: secretResolver({
        LEGACY_DEV_DSN,
        LEGACY_PROD_DSN,
      }),
      send: async (request) => {
        sent.push(request);
        return { statusCode: 202 };
      },
      queueCapacity: 4,
      concurrency: 2,
    });

    expect(
      forwarder.enqueue(
        shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "dev"),
      ),
    ).toBe("queued");
    expect(
      forwarder.enqueue(
        shadowRequest(verifiedKey("prod", "LEGACY_PROD_DSN"), "prod"),
      ),
    ).toBe("queued");
    await waitFor(() => sent.length === 2);

    expect(sent.map((request) => request.url.href).sort()).toEqual([
      "https://o1.ingest.sentry.io/api/9/envelope/?sentry_version=7&sentry_key=legacy-dev-key&sentry_client=sentry.javascript.node%2F8.55.0",
      "https://o2.ingest.sentry.io/prefix/api/10/envelope/?sentry_version=7&sentry_key=legacy-prod-key&sentry_secret=legacy-secret&sentry_client=sentry.javascript.node%2F8.55.0",
    ]);
  });

  it("does not resolve a target or send when forwarding is disabled", async () => {
    const resolve = vi.fn<() => string>();
    const send =
      vi.fn<(request: ShadowHttpRequest) => Promise<{ statusCode: number }>>();
    const forwarder = createShadowForwarder({
      secretResolver: { resolve },
      send,
      queueCapacity: 1,
      concurrency: 1,
    });

    expect(
      forwarder.enqueue(
        shadowRequest(
          {
            ...verifiedKey("dev", "LEGACY_DEV_DSN"),
            forwardingMode: "disabled",
            forwardingSecretRef: null,
          },
          "dev",
        ),
      ),
    ).toBe("disabled");
    await flushTasks();

    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects environment mismatch before resolving or queueing a destination", async () => {
    const resolve = vi.fn<() => string>();
    const send =
      vi.fn<(request: ShadowHttpRequest) => Promise<{ statusCode: number }>>();
    const metrics: ShadowForwardMetric[] = [];
    const forwarder = createShadowForwarder({
      secretResolver: { resolve },
      send,
      onMetric: (metric) => metrics.push(metric),
      queueCapacity: 1,
      concurrency: 1,
    });

    expect(
      forwarder.enqueue(
        shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "prod"),
      ),
    ).toBe("environment_mismatch");
    await flushTasks();

    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(metrics).toEqual([
      {
        outcome: "environment_mismatch",
        environment: "dev",
      },
    ]);
  });

  it("bounds all in-memory work and reports saturation without retrying", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const send = vi.fn(async () => {
      await firstPending;
      return { statusCode: 200 };
    });
    const metrics: ShadowForwardMetric[] = [];
    const forwarder = createShadowForwarder({
      secretResolver: secretResolver({ LEGACY_DEV_DSN }),
      send,
      onMetric: (metric) => metrics.push(metric),
      queueCapacity: 1,
      concurrency: 1,
    });

    const request = shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "dev");
    expect(forwarder.enqueue(request)).toBe("queued");
    expect(forwarder.enqueue(request)).toBe("saturated");
    expect(metrics).toContainEqual({
      outcome: "saturated",
      environment: "dev",
    });
    releaseFirst?.();
    await waitFor(() => metrics.some((metric) => metric.outcome === "success"));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drains queued and active forwarding work before runtime shutdown", async () => {
    let releaseSend: (() => void) | undefined;
    const pendingSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const forwarder = createShadowForwarder({
      secretResolver: secretResolver({ LEGACY_DEV_DSN }),
      send: async () => {
        await pendingSend;
        return { statusCode: 204 };
      },
      queueCapacity: 2,
      concurrency: 1,
    });
    const request = shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "dev");
    expect(forwarder.enqueue(request)).toBe("queued");
    expect(forwarder.enqueue(request)).toBe("queued");
    let drained = false;
    const drain = forwarder.drain().then(() => {
      drained = true;
    });
    await flushTasks();
    expect(drained).toBe(false);

    releaseSend?.();
    await drain;
    await expect(forwarder.drain()).resolves.toBeUndefined();
  });

  it("counts network and non-2xx failures once without retry or payload disclosure", async () => {
    const networkSend = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const networkMetrics: ShadowForwardMetric[] = [];
    const networkForwarder = createShadowForwarder({
      secretResolver: secretResolver({ LEGACY_DEV_DSN }),
      send: networkSend,
      onMetric: (metric) => networkMetrics.push(metric),
      queueCapacity: 1,
      concurrency: 1,
    });
    expect(
      networkForwarder.enqueue(
        shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "dev"),
      ),
    ).toBe("queued");
    await waitFor(() => networkMetrics.length === 1);
    await flushTasks();

    expect(networkSend).toHaveBeenCalledTimes(1);
    expect(networkMetrics).toEqual([
      {
        outcome: "failure",
        environment: "dev",
        durationMs: expect.any(Number),
        statusCode: null,
      },
    ]);
    expect(JSON.stringify(networkMetrics)).not.toContain("legacy-dev-key");
    expect(JSON.stringify(networkMetrics)).not.toContain(
      "11111111111111111111111111111111",
    );

    const statusMetrics: ShadowForwardMetric[] = [];
    const statusSend = vi.fn(async () => ({ statusCode: 503 }));
    const statusForwarder = createShadowForwarder({
      secretResolver: secretResolver({ LEGACY_DEV_DSN }),
      send: statusSend,
      onMetric: (metric) => statusMetrics.push(metric),
      queueCapacity: 1,
      concurrency: 1,
    });
    expect(
      statusForwarder.enqueue(
        shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "dev"),
      ),
    ).toBe("queued");
    await waitFor(() => statusMetrics.length === 1);

    expect(statusSend).toHaveBeenCalledTimes(1);
    expect(statusMetrics).toEqual([
      {
        outcome: "failure",
        environment: "dev",
        durationMs: expect.any(Number),
        statusCode: 503,
      },
    ]);
  });

  it("rejects an invalid configured legacy DSN without sending client data elsewhere", async () => {
    const send =
      vi.fn<(request: ShadowHttpRequest) => Promise<{ statusCode: number }>>();
    const metrics: ShadowForwardMetric[] = [];
    const forwarder = createShadowForwarder({
      secretResolver: secretResolver({
        LEGACY_DEV_DSN: "https://attacker.example/not-a-sentry-dsn",
      }),
      send,
      onMetric: (metric) => metrics.push(metric),
      queueCapacity: 1,
      concurrency: 1,
    });

    expect(
      forwarder.enqueue(
        shadowRequest(verifiedKey("dev", "LEGACY_DEV_DSN"), "dev"),
      ),
    ).toBe("invalid_target");
    await flushTasks();

    expect(send).not.toHaveBeenCalled();
    expect(metrics).toEqual([
      {
        outcome: "invalid_target",
        environment: "dev",
      },
    ]);
  });
});

function verifiedKey(
  environment: string,
  forwardingSecretRef: string,
): VerifiedIngestKey {
  return {
    id: environment === "dev" ? 1 : 2,
    projectId: 1,
    projectSlug: "intexuraos-backend",
    projectName: "IntexuraOS Backend",
    enabled: true,
    environment,
    allowedOrigins: [],
    forwardingMode: "shadow",
    forwardingSecretRef,
    webhookMode: "disabled",
    webhookTargetUrl: null,
    webhookSecretRef: null,
    enabledAt: null,
  };
}

function shadowRequest(ingestKey: VerifiedIngestKey, eventEnvironment: string) {
  return {
    ingestKey,
    eventEnvironment,
    envelope: ENVELOPE,
    contentEncoding: "gzip",
    sentryClient: "sentry.javascript.node/8.55.0",
  } as const;
}

function secretResolver(values: Readonly<Record<string, string>>) {
  return {
    resolve(reference: string): string {
      const value = values[reference];
      if (value === undefined) {
        throw new Error(`missing fixture reference: ${reference}`);
      }
      return value;
    },
  };
}

function incrementalClock(): () => number {
  let now = 0;
  return () => {
    const current = now;
    now += 1;
    return current;
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flushTasks();
  }
  throw new Error("condition was not reached");
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
