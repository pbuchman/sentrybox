import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FingerprintResult } from "@intexura-error-hub/domain";
import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { IssueRepository } from "../storage/issue-repository.js";
import { migrateDatabase } from "../storage/migrate.js";
import { OutboxRepository } from "../storage/outbox-repository.js";
import { ProjectRepository } from "../storage/project-repository.js";
import { buildCodeAgentOutboxDraft } from "./payload.js";
import {
  FetchWebhookHttpClient,
  WebhookDispatcher,
  WebhookTimeoutError,
  type WebhookHttpClient,
  type WebhookHttpRequest,
} from "./dispatcher.js";
import { nextRetryAt } from "./retry-policy.js";
import { signWebhookBody } from "./signature.js";

const CREATED_AT = "2026-07-28T10:00:00.000Z";
const PRIVATE_ORIGIN = new URL("https://error-hub.tail.example:8443");
const TARGET = "https://code-agent.example/api/code/webhooks/sentry";
const SECRET_REF = "CODE_AGENT_HMAC_BACKEND_DEV";
const SECRET = "webhook-secret";
const SECRETS = {
  references: () => [SECRET_REF],
  resolve: () => SECRET,
};
const FINGERPRINT: FingerprintResult = {
  version: 1,
  digest: "a".repeat(64),
  explanation: ["message"],
};

let directory: string;
let database: ErrorHubDatabase;
let projects: ProjectRepository;
let issues: IssueRepository;
let outbox: OutboxRepository;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "error-hub-webhooks-"));
  database = openDatabase(join(directory, "error-hub.sqlite"));
  migrateDatabase(database, CREATED_AT);
  projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "intexuraos-backend",
    name: "IntexuraOS Backend",
    enabled: true,
    createdAt: CREATED_AT,
  });
  issues = new IssueRepository(database);
  outbox = new OutboxRepository(database);
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("webhook lifecycle and dispatch", () => {
  it("keeps disabled transitions suppressed and starts only post-baseline generations", () => {
    setKey("disabled");
    const first = record("event-1", FINGERPRINT);
    expect(outbox.getById(required(first.outboxId))).toMatchObject({
      state: "suppressed",
      attempts: 0,
      nextAttempt: null,
    });
    const disabledSend = vi.fn<WebhookHttpClient["send"]>();
    const disabledDispatcher = createDispatcher(
      disabledSend,
      CREATED_AT,
      "disabled",
    );
    return expect(disabledDispatcher.dispatchDue())
      .resolves.toMatchObject({ claimed: 0 })
      .then(() => {
        expect(disabledSend).not.toHaveBeenCalled();
      })
      .then(() => {
        projects.enableWebhookDestination({
          projectId: 1,
          environment: "dev",
          targetUrl: TARGET,
          secretRef: SECRET_REF,
          enabledAt: "2026-07-28T10:05:00.000Z",
          secrets: SECRETS,
        });
        expect(projects.verifyIngestKey(1, "public-key")).toMatchObject({
          webhookMode: "live",
          enabledAt: "2026-07-28T10:05:00.000Z",
        });

        const repeated = record("event-2", FINGERPRINT, {
          receivedAt: "2026-07-28T10:06:00.000Z",
        });
        expect(repeated.outboxId).toBeNull();
        const second = record("event-3", {
          ...FINGERPRINT,
          digest: "b".repeat(64),
        });
        expect(outbox.getById(required(second.outboxId))).toMatchObject({
          state: "pending",
          eventId: "event-3",
          generation: 1,
        });

        issues.resolve(first.issueId, "2026-07-28T10:07:00.000Z");
        const regression = record("event-4", FINGERPRINT, {
          receivedAt: "2026-07-28T10:08:00.000Z",
        });
        const transitions = outbox.listByIssue(first.issueId);
        expect(transitions).toMatchObject([
          { state: "suppressed", generation: 1, cause: "created" },
          {
            state: "pending",
            generation: 2,
            cause: "regressed",
            eventId: "event-4",
          },
        ]);
        expect(
          JSON.parse(required(transitions[1]).body.toString("utf8")),
        ).toMatchObject({
          action: "triggered",
          data: { event: { event_id: "event-4" } },
        });
        expect(regression.outcome).toBe("regressed");
      });
  });

  it("pins the signature before sending so automatic retries survive secret rotation", async () => {
    setKey("live");
    let activeSecret = SECRET;
    const resolve = vi.fn(() => activeSecret);
    const created = record(
      "4f7a4f2c0e8e4c2a9c3d5e7f90123456",
      FINGERPRINT,
      {},
      { references: () => [SECRET_REF], resolve },
    );
    activeSecret = "rotated-secret";
    const row = outbox.getById(required(created.outboxId));
    const requests: WebhookHttpRequest[] = [];
    const responses = [500, 204];
    let now = new Date(CREATED_AT);
    const http: WebhookHttpClient = {
      async send(request) {
        requests.push(request);
        return { statusCode: required(responses.shift()) };
      },
    };
    const dispatcher = new WebhookDispatcher({
      outbox,
      http,
      now: () => now,
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      createLeaseId: () => `lease-${requests.length}`,
    });

    expect(await dispatcher.dispatchDue()).toEqual({
      claimed: 1,
      delivered: 0,
      retried: 1,
      deadLettered: 0,
    });
    expect(outbox.getById(required(created.outboxId))).toMatchObject({
      state: "retry",
      attempts: 1,
      nextAttempt: "2026-07-28T10:00:30.000Z",
      lastError: "HTTP 500",
    });

    now = new Date("2026-07-28T10:00:30.000Z");
    expect(await dispatcher.dispatchDue()).toMatchObject({ delivered: 1 });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toEqual(row?.body);
    expect(requests[1]?.body).toEqual(row?.body);
    expect(requests[1]?.headers).toEqual(requests[0]?.headers);
    expect(requests[0]?.headers["X-Error-Hub-Delivery"]).toBe(row?.deliveryId);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(SECRET_REF);
    expect(row?.signature).not.toBe(
      signWebhookBody(required(row).body, "rotated-secret"),
    );
  });

  it("prevents concurrent ticks from delivering one due row twice and retries after an expired lease", async () => {
    setKey("live");
    record("event-lease", FINGERPRINT);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await blocked;
      return { statusCode: 204 };
    });
    const dispatcher = createDispatcher(send, CREATED_AT, "lease-a");

    const firstTick = dispatcher.dispatchDue();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(await dispatcher.dispatchDue()).toEqual({
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    });
    release?.();
    await firstTick;
    expect(send).toHaveBeenCalledOnce();

    const retryable = record("event-crash", {
      ...FINGERPRINT,
      digest: "c".repeat(64),
    });
    const claimed = outbox.claimDue(
      "2026-07-28T10:00:00.000Z",
      "2026-07-28T10:00:10.000Z",
      "crashed-lease",
      10,
    );
    expect(claimed.map((candidate) => candidate.id)).toContain(
      required(retryable.outboxId),
    );
    expect(
      outbox.claimDue(
        "2026-07-28T10:00:09.999Z",
        "2026-07-28T10:00:20.000Z",
        "early",
        10,
      ),
    ).toHaveLength(0);
    expect(
      outbox.claimDue(
        "2026-07-28T10:00:10.000Z",
        "2026-07-28T10:00:20.000Z",
        "recovered",
        10,
      ),
    ).toHaveLength(1);
  });

  it("starts every claimed batch request inside one lease window", async () => {
    setKey("live");
    record("batch-1", FINGERPRINT);
    record("batch-2", { ...FINGERPRINT, digest: "d".repeat(64) });
    record("batch-3", { ...FINGERPRINT, digest: "e".repeat(64) });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await blocked;
      return { statusCode: 204 };
    });
    const dispatcher = new WebhookDispatcher({
      outbox,
      http: { send },
      now: () => new Date(CREATED_AT),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      batchSize: 3,
      createLeaseId: () => "batch-lease",
    });

    const tick = dispatcher.dispatchDue();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(await dispatcher.dispatchDue()).toMatchObject({ claimed: 0 });
    release?.();
    await expect(tick).resolves.toEqual({
      claimed: 3,
      delivered: 3,
      retried: 0,
      deadLettered: 0,
    });
  });

  it("bounds stale maintenance by the per-tick batch budget without sending", async () => {
    setKey("live");
    for (let index = 1; index <= 7; index += 1) {
      record(`stale-${String(index)}`, {
        ...FINGERPRINT,
        digest: index.toString(16).padStart(64, "0"),
      });
    }
    const send = vi.fn<WebhookHttpClient["send"]>();
    const dispatcher = new WebhookDispatcher({
      outbox,
      http: { send },
      now: () => new Date("2026-08-04T10:00:00.001Z"),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      batchSize: 3,
      createLeaseId: () => "bounded-maintenance",
    });

    await expect(dispatcher.dispatchDue()).resolves.toEqual({
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `SELECT state, COUNT(*) AS count
           FROM webhook_outbox
           GROUP BY state
           ORDER BY state`,
        )
        .all(),
    ).toEqual([
      { state: "dead_letter", count: 3 },
      { state: "pending", count: 4 },
    ]);
  });

  it("dispatches a bounded batch from a large all-normal due backlog", async () => {
    setKey("live");
    for (let index = 1; index <= 100; index += 1) {
      record(
        `normal-backlog-${String(index)}`,
        {
          ...FINGERPRINT,
          digest: (index + 100).toString(16).padStart(64, "0"),
        },
        {
          occurredAt: "2026-08-04T09:00:00.000Z",
          receivedAt: "2026-08-04T09:00:00.000Z",
        },
      );
    }
    const dispatcher = new WebhookDispatcher({
      outbox,
      http: {
        async send() {
          return { statusCode: 204 };
        },
      },
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      batchSize: 3,
      createLeaseId: () => "normal-frontier",
    });

    await expect(dispatcher.dispatchDue()).resolves.toEqual({
      claimed: 3,
      delivered: 3,
      retried: 0,
      deadLettered: 0,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_outbox WHERE state = 'pending'",
        )
        .get(),
    ).toEqual({ count: 97 });
  });

  it("sends normal due prefix rows without scanning ahead to invalid work", async () => {
    setKey("live");
    const normalIds: number[] = [];
    for (let index = 1; index <= 5; index += 1) {
      normalIds.push(
        required(
          record(
            `normal-prefix-${String(index)}`,
            {
              ...FINGERPRINT,
              digest: (index + 300).toString(16).padStart(64, "0"),
            },
            {
              occurredAt: "2026-08-04T09:00:00.000Z",
              receivedAt: "2026-08-04T09:00:00.000Z",
            },
          ).outboxId,
        ),
      );
    }
    const staleIds: number[] = [];
    for (let index = 1; index <= 3; index += 1) {
      staleIds.push(
        required(
          record(`invalid-after-prefix-${String(index)}`, {
            ...FINGERPRINT,
            digest: (index + 400).toString(16).padStart(64, "0"),
          }).outboxId,
        ),
      );
    }
    database
      .prepare(
        `UPDATE webhook_outbox
         SET next_attempt = '2026-08-04T09:30:00.000Z'
         WHERE id IN (?, ?, ?)`,
      )
      .run(...staleIds);
    const dispatcher = new WebhookDispatcher({
      outbox,
      http: {
        async send() {
          return { statusCode: 204 };
        },
      },
      now: () => new Date("2026-08-04T10:00:00.001Z"),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      batchSize: 3,
      createLeaseId: () => "mixed-frontier",
    });

    await expect(dispatcher.dispatchDue()).resolves.toEqual({
      claimed: 3,
      delivered: 3,
      retried: 0,
      deadLettered: 0,
    });
    expect(normalIds.map((id) => outbox.getById(id)?.state)).toEqual([
      "delivered",
      "delivered",
      "delivered",
      "pending",
      "pending",
    ]);
    expect(staleIds.map((id) => outbox.getById(id)?.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("starts the delivery lease after bounded maintenance finishes", async () => {
    setKey("live");
    record("stale-before-claim", FINGERPRINT);
    const fresh = record(
      "fresh-after-maintenance",
      { ...FINGERPRINT, digest: "2".repeat(64) },
      {
        occurredAt: "2026-08-04T10:00:00.000Z",
        receivedAt: "2026-08-04T10:00:00.000Z",
      },
    );
    const timestamps = [
      "2026-08-04T10:00:00.001Z",
      "2026-08-04T10:00:05.000Z",
      "2026-08-04T10:00:05.000Z",
      "2026-08-04T10:00:05.000Z",
      "2026-08-04T10:00:05.000Z",
    ];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = new WebhookDispatcher({
      outbox,
      http: {
        async send() {
          await blocked;
          return { statusCode: 204 };
        },
      },
      now: () => new Date(required(timestamps.shift())),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      batchSize: 2,
      createLeaseId: () => "post-maintenance-lease",
    });

    const tick = dispatcher.dispatchDue();
    await vi.waitFor(() =>
      expect(outbox.getById(required(fresh.outboxId))).toMatchObject({
        dispatchLeaseId: "post-maintenance-lease",
        dispatchLeaseUntil: "2026-08-04T10:00:15.000Z",
      }),
    );
    release?.();
    await expect(tick).resolves.toMatchObject({ claimed: 1, delivered: 1 });
  });

  it("shares one batch limit fairly between automatic deliveries and redrives", async () => {
    setKey("live");
    const automatic = record("automatic-1", FINGERPRINT);
    record("automatic-2", {
      ...FINGERPRINT,
      digest: "3".repeat(64),
    });
    const failedOne = record("failed-1", {
      ...FINGERPRINT,
      digest: "4".repeat(64),
    });
    const failedTwo = record("failed-2", {
      ...FINGERPRINT,
      digest: "5".repeat(64),
    });
    database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'dead_letter', next_attempt = NULL, last_error = 'failed'
         WHERE id IN (?, ?)`,
      )
      .run(required(failedOne.outboxId), required(failedTwo.outboxId));
    outbox.requestRedrive({
      outboxId: required(failedOne.outboxId),
      deliveryId: "11111111-1111-4111-8111-111111111111",
      requestedAt: CREATED_AT,
      secrets: SECRETS,
    });
    outbox.requestRedrive({
      outboxId: required(failedTwo.outboxId),
      deliveryId: "22222222-2222-4222-8222-222222222222",
      requestedAt: CREATED_AT,
      secrets: SECRETS,
    });
    const requests: WebhookHttpRequest[] = [];
    const dispatcher = new WebhookDispatcher({
      outbox,
      http: {
        async send(request) {
          requests.push(request);
          return { statusCode: 204 };
        },
      },
      now: () => new Date(CREATED_AT),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      batchSize: 1,
      createLeaseId: () => "shared-batch",
    });

    await expect(dispatcher.dispatchDue()).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(outbox.getById(required(automatic.outboxId))?.state).toBe(
      "delivered",
    );
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_redrives WHERE state = 'delivered'",
        )
        .get(),
    ).toEqual({ count: 0 });

    await expect(dispatcher.dispatchDue()).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(requests).toHaveLength(2);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_outbox WHERE state = 'delivered'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM webhook_redrives WHERE state = 'delivered'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("does not let an expired lease completion overwrite a newer claim", () => {
    setKey("live");
    const created = record("stale-lease", FINGERPRINT);
    const outboxId = required(created.outboxId);
    expect(
      outbox.claimDue(CREATED_AT, "2026-07-28T10:00:10.000Z", "old-lease", 1),
    ).toHaveLength(1);
    expect(
      outbox.claimDue(
        "2026-07-28T10:00:10.000Z",
        "2026-07-28T10:00:20.000Z",
        "new-lease",
        1,
      ),
    ).toHaveLength(1);

    expect(
      outbox.completeDelivered(
        outboxId,
        "old-lease",
        "2026-07-28T10:00:11.000Z",
      ),
    ).toBe(false);
    expect(outbox.getById(outboxId)).toMatchObject({
      state: "pending",
      dispatchLeaseId: "new-lease",
    });
    expect(
      outbox.completeDelivered(
        outboxId,
        "new-lease",
        "2026-07-28T10:00:12.000Z",
      ),
    ).toBe(true);
  });

  it("rejects a wrong live URL or unconfigured secret before persistence", () => {
    expect(() =>
      setKey("live", "http://code-agent.invalid/api/code/webhooks/sentry"),
    ).toThrow(/canonical HTTPS/u);
    expect(() =>
      projects.setIngestKey({
        projectId: 1,
        environment: "dev",
        publicKey: "public-key",
        allowedOrigins: [],
        forwardingMode: "disabled",
        forwardingSecretRef: null,
        webhookMode: "live",
        webhookTargetUrl: TARGET,
        webhookSecretRef: "UNKNOWN_SECRET",
        enabledAt: CREATED_AT,
        webhookSecrets: SECRETS,
      }),
    ).toThrow(/not configured/u);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM project_ingest_keys")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("uses transactional destination state rather than a paused auth snapshot", () => {
    setKey("disabled");
    const staleDisabled = required(projects.verifyIngestKey(1, "public-key"));
    const controlDatabase = openDatabase(join(directory, "error-hub.sqlite"));
    const controlProjects = new ProjectRepository(controlDatabase);
    controlProjects.enableWebhookDestination({
      projectId: 1,
      environment: "dev",
      targetUrl: TARGET,
      secretRef: SECRET_REF,
      enabledAt: "2026-07-28T10:01:00.000Z",
      secrets: SECRETS,
    });
    const afterEnable = record(
      "after-enable",
      FINGERPRINT,
      {},
      SECRETS,
      staleDisabled,
    );
    expect(outbox.getById(required(afterEnable.outboxId))).toMatchObject({
      state: "pending",
      destinationMode: "live",
    });

    const staleLive = required(projects.verifyIngestKey(1, "public-key"));
    controlProjects.disableWebhookDestination({
      projectId: 1,
      environment: "dev",
      disabledAt: "2026-07-28T10:02:00.000Z",
    });
    const afterDisable = record(
      "after-disable",
      { ...FINGERPRINT, digest: "f".repeat(64) },
      {},
      SECRETS,
      staleLive,
    );
    expect(outbox.getById(required(afterDisable.outboxId))).toMatchObject({
      state: "suppressed",
      destinationMode: "disabled",
    });
    expect(outbox.listByIssue(afterDisable.issueId)).toHaveLength(1);
    controlDatabase.close();
  });

  it("dead-letters an invalid legacy stored destination as configuration without network", async () => {
    setKey("live");
    const created = record("legacy-invalid-target", FINGERPRINT);
    const outboxId = required(created.outboxId);
    database.exec("DROP TRIGGER webhook_outbox_immutable_fields");
    database
      .prepare("UPDATE webhook_outbox SET target_url = ? WHERE id = ?")
      .run("http://legacy.invalid/not-code-agent", outboxId);
    const send = vi.fn<WebhookHttpClient["send"]>();
    const dispatcher = createDispatcher(send, CREATED_AT, "legacy-invalid");

    await expect(dispatcher.dispatchDue()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      retried: 0,
      deadLettered: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getById(outboxId)).toMatchObject({
      state: "dead_letter",
      attempts: 1,
      lastError: "invalid destination configuration",
      dispatchLeaseId: null,
    });
  });

  it("terminally dead-letters attempt overflow before network", async () => {
    setKey("live");
    const created = record("attempt-overflow", FINGERPRINT);
    const outboxId = required(created.outboxId);
    database
      .prepare(
        "UPDATE webhook_outbox SET attempts = 9007199254740991 WHERE id = ?",
      )
      .run(outboxId);
    const send = vi.fn<WebhookHttpClient["send"]>();
    const dispatcher = createDispatcher(send, CREATED_AT, "overflow");

    await expect(dispatcher.dispatchDue()).resolves.toMatchObject({
      claimed: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getById(outboxId)).toMatchObject({
      state: "dead_letter",
      attempts: 9007199254740991,
      lastError: "delivery attempt limit exhausted",
    });
  });

  it.each([
    [204, "delivered"],
    [408, "retry"],
    [429, "retry"],
    [503, "retry"],
    [400, "dead_letter"],
    [401, "dead_letter"],
    [403, "dead_letter"],
    [404, "dead_letter"],
    [302, "dead_letter"],
  ] as const)("classifies HTTP %i as %s", async (statusCode, state) => {
    setKey("live");
    const created = record(`event-${String(statusCode)}`, FINGERPRINT);
    const dispatcher = createDispatcher(
      async () => ({ statusCode }),
      CREATED_AT,
      `lease-${String(statusCode)}`,
    );

    await dispatcher.dispatchDue();

    expect(outbox.getById(required(created.outboxId))?.state).toBe(state);
  });

  it("dead-letters retryable failures after the seven-day window and remains inspectable", async () => {
    setKey("live");
    const created = record("event-expired", FINGERPRINT);
    database
      .prepare("UPDATE webhook_outbox SET next_attempt = ? WHERE id = ?")
      .run("2026-08-04T10:00:00.000Z", required(created.outboxId));
    const dispatcher = createDispatcher(
      async () => {
        throw new Error(`network failed: ${SECRET}`);
      },
      "2026-08-04T10:00:00.000Z",
      "expired",
    );

    await dispatcher.dispatchDue();

    expect(outbox.getById(required(created.outboxId))).toMatchObject({
      state: "dead_letter",
      attempts: 1,
      nextAttempt: null,
      lastError: "network failure",
    });
    expect(
      JSON.stringify(outbox.getById(required(created.outboxId))),
    ).not.toContain(SECRET);
  });

  it("expires stale automatic work before network and sends one audited corrected redrive", async () => {
    setKey("live");
    const created = record("stale-automatic", FINGERPRINT);
    const outboxId = required(created.outboxId);
    const original = required(outbox.getById(outboxId));
    const automaticSend = vi.fn<WebhookHttpClient["send"]>();
    const expiredDispatcher = createDispatcher(
      automaticSend,
      "2026-08-04T10:00:00.001Z",
      "expired-auto",
    );

    await expect(expiredDispatcher.dispatchDue()).resolves.toMatchObject({
      claimed: 0,
    });
    expect(automaticSend).not.toHaveBeenCalled();
    expect(outbox.getById(outboxId)).toMatchObject({
      state: "dead_letter",
      attempts: 0,
      lastError: "automatic retry window expired",
    });

    const correctedTarget =
      "https://fixed-code-agent.example/api/code/webhooks/sentry";
    const correctedRef = "CODE_AGENT_HMAC_FIXED";
    const correctedSecrets = {
      references: () => [SECRET_REF, correctedRef],
      resolve: (reference: string) =>
        reference === correctedRef ? "corrected-secret" : SECRET,
    };
    projects.enableWebhookDestination({
      projectId: 1,
      environment: "dev",
      targetUrl: correctedTarget,
      secretRef: correctedRef,
      enabledAt: "2026-08-04T10:00:00.002Z",
      secrets: correctedSecrets,
    });
    const redrive = outbox.requestRedrive({
      outboxId,
      deliveryId: "608902f0-f65c-4c2a-9b9b-6dadcd810f27",
      requestedAt: "2026-08-04T10:00:00.003Z",
      secrets: correctedSecrets,
    });
    expect(redrive).toMatchObject({
      originalOutboxId: outboxId,
      targetUrl: correctedTarget,
      secretRef: correctedRef,
      state: "pending",
      attempts: 0,
    });
    expect(redrive.signature).not.toBe(original.signature);
    expect(outbox.getById(outboxId)).toMatchObject({
      targetUrl: original.targetUrl,
      secretRef: original.secretRef,
      signature: original.signature,
      body: original.body,
      state: "dead_letter",
    });

    const redriveRequests: WebhookHttpRequest[] = [];
    const redriveDispatcher = createDispatcher(
      async (request) => {
        redriveRequests.push(request);
        return { statusCode: 204 };
      },
      "2026-08-04T10:00:00.003Z",
      "redrive-lease",
    );
    await expect(redriveDispatcher.dispatchDue()).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(redriveRequests).toHaveLength(1);
    expect(redriveRequests[0]).toMatchObject({
      body: original.body,
      targetUrl: new URL(correctedTarget),
      headers: {
        "X-Error-Hub-Delivery": redrive.deliveryId,
        "Sentry-Hook-Signature": redrive.signature,
      },
    });
    expect(outbox.getRedriveById(redrive.id)).toMatchObject({
      state: "delivered",
      attempts: 1,
      attemptedAt: "2026-08-04T10:00:00.003Z",
    });
  });
});

describe("fetch webhook HTTP boundary", () => {
  it("posts without following redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FetchWebhookHttpClient().send({
      body: Buffer.from("payload"),
      targetUrl: new URL(TARGET),
      headers: { "Content-Type": "application/json" },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ statusCode: 302 });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(TARGET),
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("aborts at the request timeout without exposing the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: URL, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted with private response")),
            );
          }),
      ),
    );

    await expect(
      new FetchWebhookHttpClient().send({
        body: Buffer.from("secret payload"),
        targetUrl: new URL(TARGET),
        headers: {},
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(WebhookTimeoutError);
  });
});

describe("retry schedule", () => {
  it("uses 30s, 2m, 10m, 1h, 6h, then 12h until seven days", () => {
    const expected = [30, 120, 600, 3_600, 21_600, 43_200, 43_200];
    for (let attempt = 1; attempt <= expected.length; attempt += 1) {
      const failedAt = new Date(CREATED_AT);
      expect(
        (Date.parse(
          required(nextRetryAt(CREATED_AT, failedAt.toISOString(), attempt)),
        ) -
          failedAt.getTime()) /
          1_000,
      ).toBe(expected[attempt - 1]);
    }
    expect(nextRetryAt(CREATED_AT, "2026-08-04T09:59:59.000Z", 8)).toBeNull();
  });
});

function setKey(mode: "disabled" | "live", targetUrl: string = TARGET): void {
  projects.setIngestKey({
    projectId: 1,
    environment: "dev",
    publicKey: "public-key",
    allowedOrigins: [],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: mode,
    webhookTargetUrl: mode === "live" ? targetUrl : null,
    webhookSecretRef: mode === "live" ? SECRET_REF : null,
    enabledAt: mode === "live" ? CREATED_AT : null,
    ...(mode === "live" ? { webhookSecrets: SECRETS } : {}),
  });
}

function record(
  eventId: string,
  fingerprint: FingerprintResult,
  overrides: Partial<NormalizedEvent> = {},
  secrets = SECRETS,
  ingestKeyOverride?: ReturnType<ProjectRepository["verifyIngestKey"]>,
) {
  const ingestKey = required(
    ingestKeyOverride ?? projects.verifyIngestKey(1, "public-key"),
  );
  const event: NormalizedEvent = {
    id: eventId,
    occurredAt: CREATED_AT,
    receivedAt: CREATED_AT,
    level: "error",
    title: "TypeError: boom",
    message: "boom",
    exception: null,
    breadcrumbs: [],
    tags: {},
    release: "1.0.0",
    environment: "dev",
    serverName: "api",
    platform: "node",
    logger: "api",
    requestId: null,
    traceId: null,
    taskId: null,
    payload: { contexts: {}, extras: {}, correlations: {} },
    payloadBytes: 100,
    truncated: false,
    truncationReasons: [],
    ...overrides,
  };
  return issues.recordOccurrence({
    projectId: 1,
    event,
    fingerprint,
    buildOutbox: (transition, destination) =>
      buildCodeAgentOutboxDraft({
        ingestKey,
        event,
        transition,
        destination,
        organizationSlug: "intexuraos",
        privateHubOrigin: PRIVATE_ORIGIN,
        deliveryId: deliveryId(transition.issueId, transition.generation),
        secrets,
      }),
  });
}

function createDispatcher(
  send: WebhookHttpClient["send"],
  now: string,
  leaseId: string,
): WebhookDispatcher {
  return new WebhookDispatcher({
    outbox,
    http: { send },
    now: () => new Date(now),
    requestTimeoutMs: 2_000,
    leaseMs: 10_000,
    createLeaseId: () => leaseId,
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("required value");
  return value;
}

function deliveryId(issueId: number, generation: number): string {
  const suffix = String(issueId * 1_000 + generation).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}
