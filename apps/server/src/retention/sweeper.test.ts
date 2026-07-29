import type { FingerprintResult } from "@intexura-error-hub/domain";
import type { NormalizedEvent } from "@intexura-error-hub/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ErrorHubDatabase } from "../storage/database.js";
import { IssueRepository } from "../storage/issue-repository.js";
import { migrateDatabase } from "../storage/migrate.js";
import { ProjectRepository } from "../storage/project-repository.js";
import {
  DEFAULT_RETENTION_CONFIG,
  StorageSafetyState,
  type PhysicalStorageUsage,
  type RetentionConfig,
} from "./storage-budget.js";
import { RetentionSweeper } from "./sweeper.js";
import { createOperationsContext } from "../operations.js";

const NOW = "2026-08-28T10:00:00.000Z";
const THIRTY_DAY_CUTOFF = "2026-07-29T10:00:00.000Z";
const SEVEN_DAY_CUTOFF = "2026-08-21T10:00:00.000Z";
const FINGERPRINT: FingerprintResult = {
  version: 1,
  digest: "a".repeat(64),
  explanation: ["message"],
};

let database: ErrorHubDatabase;
let issues: IssueRepository;
let sequence: number;

beforeEach(() => {
  database = openDatabase(":memory:");
  migrateDatabase(database, "2026-07-28T00:00:00.000Z");
  const projects = new ProjectRepository(database);
  projects.create({
    id: 1,
    slug: "backend",
    name: "Backend",
    enabled: true,
    createdAt: "2026-07-28T00:00:00.000Z",
  });
  projects.setIngestKey({
    projectId: 1,
    environment: "dev",
    publicKey: "public-key",
    allowedOrigins: [],
    forwardingMode: "disabled",
    forwardingSecretRef: null,
    webhookMode: "live",
    webhookTargetUrl: "https://code-agent.example/api/code/webhooks/sentry",
    webhookSecretRef: "HOOK",
    enabledAt: "2026-07-28T00:00:00.000Z",
    webhookSecrets: { references: () => ["HOOK"] },
  });
  issues = new IssueRepository(database);
  sequence = 0;
});

afterEach(() => {
  database.close();
});

describe("RetentionSweeper", () => {
  it("uses strict received-at age boundaries and recomputes every retained aggregate and nullable facet", async () => {
    const issue = record({
      receivedAt: "2026-07-29T09:59:59.999Z",
      occurredAt: "2026-08-27T10:00:00.000Z",
      level: "fatal",
      release: "old",
      service: "old-service",
    });
    record({
      receivedAt: THIRTY_DAY_CUTOFF,
      occurredAt: "2026-07-02T10:00:00.000Z",
      level: "error",
      release: "2.0.0",
      service: "api",
    });
    record({
      receivedAt: "2026-07-31T10:00:00.000Z",
      occurredAt: "2026-07-01T10:00:00.000Z",
      level: "warn",
      release: null,
      service: null,
    });
    const empty = record({
      fingerprint: "b",
      receivedAt: "2026-07-01T00:00:00.000Z",
      occurredAt: "2026-08-28T00:00:00.000Z",
    });

    const result = await createSweeper().run();

    expect(result).toMatchObject({
      success: true,
      removedEvents: { age: 2, budget: 0 },
    });
    expect(issues.getById(issue.issueId)).toMatchObject({
      occurrenceCount: 2,
      firstSeen: "2026-07-01T10:00:00.000Z",
      lastSeen: "2026-07-02T10:00:00.000Z",
      lastReceivedAt: "2026-07-31T10:00:00.000Z",
      highestLevel: "error",
    });
    expect(issues.getById(empty.issueId)).toBeNull();
    expect(issues.listFacets(issue.issueId)).toEqual([
      {
        facetType: "environment",
        facetValue: "dev",
        count: 2,
        lastSeen: "2026-07-02T10:00:00.000Z",
      },
      {
        facetType: "level",
        facetValue: "error",
        count: 1,
        lastSeen: "2026-07-02T10:00:00.000Z",
      },
      {
        facetType: "level",
        facetValue: "warn",
        count: 1,
        lastSeen: "2026-07-01T10:00:00.000Z",
      },
      {
        facetType: "release",
        facetValue: "2.0.0",
        count: 1,
        lastSeen: "2026-07-02T10:00:00.000Z",
      },
      {
        facetType: "release",
        facetValue: null,
        count: 1,
        lastSeen: "2026-07-01T10:00:00.000Z",
      },
      {
        facetType: "service",
        facetValue: "api",
        count: 1,
        lastSeen: "2026-07-02T10:00:00.000Z",
      },
      {
        facetType: "service",
        facetValue: null,
        count: 1,
        lastSeen: "2026-07-01T10:00:00.000Z",
      },
    ]);
  });

  it("does not sweep at exactly 4 GiB and sweeps global oldest-first to 3.6 GiB in bounded yielding batches", async () => {
    const gib = 1024 ** 3;
    const rows = [
      record({ fingerprint: "a", receivedAt: "2026-08-22T00:00:00.000Z" }),
      record({ fingerprint: "b", receivedAt: "2026-08-23T00:00:00.000Z" }),
      record({ fingerprint: "c", receivedAt: "2026-08-24T00:00:00.000Z" }),
    ];
    setLogicalBytes(rows, [2 * gib, 2 * gib, 0]);
    const exact = await createSweeper().run();
    expect(exact.removedEvents.budget).toBe(0);
    expect(eventIds()).toHaveLength(3);

    setLogicalBytes(rows, [2 * gib, 2 * gib, 1]);
    const batches: number[][] = [];
    const yields: number[] = [];
    const result = await createSweeper({
      config: { batchSize: 1 },
      onBatch: (batch) => batches.push([...batch.eventIds]),
      yieldControl: async () => {
        yields.push(yields.length);
      },
    }).run();

    expect(result.removedEvents.budget).toBe(1);
    expect(batches).toEqual([[rows[0]!.eventRowId]]);
    expect(yields).toHaveLength(3);
    expect(eventIds()).toEqual([rows[1]!.eventRowId, rows[2]!.eventRowId]);
    expect(result.usage.logicalPayloadBytes).toBeLessThanOrEqual(3.6 * gib);
  });

  it("rolls back the whole event batch and marks storage unsafe when recomputation fails after delete", async () => {
    const old = record({ receivedAt: "2026-07-01T00:00:00.000Z" });
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    const observer = vi.fn(() => {
      throw new Error("aggregate failure");
    });

    const result = await createSweeper({
      safetyState: state,
      onBatch: observer,
    }).run();

    expect(result.success).toBe(false);
    expect(eventIds()).toContain(old.eventRowId);
    expect(issues.getById(old.issueId)).toMatchObject({ occurrenceCount: 1 });
    expect(state.snapshot()).toMatchObject({
      acceptingIngest: false,
      retentionKnownSuccessful: false,
      safety: "unsafe",
    });
  });

  it("cleans delivered outbox and terminal redrives at strict independent TTL boundaries while preserving pending", async () => {
    const oldDelivered = record({ fingerprint: "a" });
    const boundaryDelivered = record({ fingerprint: "b" });
    const parent = record({ fingerprint: "c" });
    database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'delivered', next_attempt = NULL, delivered_at = ?,
             attempts = 1
         WHERE id = ?`,
      )
      .run("2026-08-21T09:59:59.999Z", oldDelivered.outboxId);
    database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'delivered', next_attempt = NULL, delivered_at = ?,
             attempts = 1
         WHERE id = ?`,
      )
      .run(SEVEN_DAY_CUTOFF, boundaryDelivered.outboxId);
    database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'dead_letter', next_attempt = NULL, last_error = 'failed'
         WHERE id = ?`,
      )
      .run(parent.outboxId);
    database
      .prepare(
        `INSERT INTO webhook_redrives(
           delivery_id, original_outbox_id, target_url, secret_ref, signature,
           state, attempts, requested_at, attempted_at, last_error
         ) VALUES
           ('11111111-1111-4111-8111-111111111111', ?, 'https://code-agent.example/api/code/webhooks/sentry', 'HOOK', ?, 'delivered', 1, ?, ?, NULL),
           ('22222222-2222-4222-8222-222222222222', ?, 'https://code-agent.example/api/code/webhooks/sentry', 'HOOK', ?, 'dead_letter', 1, ?, ?, 'failed'),
           ('33333333-3333-4333-8333-333333333333', ?, 'https://code-agent.example/api/code/webhooks/sentry', 'HOOK', ?, 'pending', 0, ?, NULL, NULL)`,
      )
      .run(
        parent.outboxId,
        "a".repeat(64),
        "2026-08-20T00:00:00.000Z",
        "2026-08-21T09:59:59.999Z",
        parent.outboxId,
        "b".repeat(64),
        "2026-08-20T00:00:00.000Z",
        SEVEN_DAY_CUTOFF,
        parent.outboxId,
        "c".repeat(64),
        "2026-08-20T00:00:00.000Z",
      );

    const result = await createSweeper().run();

    expect(result).toMatchObject({ removedOutbox: 1, removedRedrives: 1 });
    expect(
      database
        .prepare("SELECT id FROM webhook_outbox ORDER BY id")
        .all()
        .map((row) => (row as { id: number }).id),
    ).toContain(boundaryDelivered.outboxId);
    expect(
      database
        .prepare("SELECT state, attempted_at FROM webhook_redrives ORDER BY id")
        .all(),
    ).toEqual([
      { state: "dead_letter", attempted_at: SEVEN_DAY_CUTOFF },
      { state: "pending", attempted_at: null },
    ]);
    expect(
      database
        .prepare("SELECT state FROM webhook_outbox WHERE id = ?")
        .get(parent.outboxId),
    ).toEqual({ state: "dead_letter" });
  });

  it("runs passive checkpoint and bounded incremental vacuum only after committed cleanup", async () => {
    record({ receivedAt: "2026-07-01T00:00:00.000Z" });
    const checkpoint = vi.fn(() => ({
      busy: 0,
      logFrames: 7,
      checkpointedFrames: 7,
    }));
    const incrementalVacuum = vi.fn();

    const result = await createSweeper({
      checkpoint,
      incrementalVacuum,
    }).run();

    expect(checkpoint).toHaveBeenCalledOnce();
    expect(incrementalVacuum).toHaveBeenCalledWith(
      DEFAULT_RETENTION_CONFIG.incrementalVacuumPages,
    );
    expect(result.checkpoint).toEqual({
      busy: 0,
      logFrames: 7,
      checkpointedFrames: 7,
    });
  });

  it("recovers critical physical usage only after an explicit bounded emergency reclaim and real resample", async () => {
    const critical = usage({
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes,
    });
    const recovered = usage({
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes - 1,
    });
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    let reclaimed = false;
    const emergencyCheckpoint = vi.fn(() => {
      reclaimed = true;
      return { busy: 0, logFrames: 8, checkpointedFrames: 8 };
    });

    const result = await createSweeper({
      safetyState: state,
      readPhysicalUsage: () => (reclaimed ? recovered : critical),
      emergencyCheckpoint,
    }).run();

    expect(emergencyCheckpoint).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(state.snapshot()).toMatchObject({
      acceptingIngest: true,
      retentionKnownSuccessful: true,
      physicalUsage: recovered,
    });
  });

  it("rejects ingest after cleanup when physical usage remains at 4.75 GiB", async () => {
    const critical = usage({
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes,
    });
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    const emergencyCheckpoint = vi.fn(() => ({
      busy: 0,
      logFrames: 8,
      checkpointedFrames: 8,
    }));

    const result = await createSweeper({
      safetyState: state,
      readPhysicalUsage: () => critical,
      emergencyCheckpoint,
    }).run();

    expect(result.success).toBe(false);
    expect(result.failure).toBe("physical_storage_critical");
    expect(state.snapshot()).toMatchObject({
      acceptingIngest: false,
      retentionKnownSuccessful: false,
      safety: "critical",
    });
    expect(emergencyCheckpoint).toHaveBeenCalled();
  });

  it("publishes event-batch critical safety before yielding and stops further cleanup at the hard limit", async () => {
    const first = record({
      fingerprint: "a",
      receivedAt: "2026-07-01T00:00:00.000Z",
    });
    const second = record({
      fingerprint: "b",
      receivedAt: "2026-07-02T00:00:00.000Z",
    });
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    const safe = usage();
    const hard = usage({
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalTotalBytes,
    });
    let samples = 0;
    const safetyAtYield: ReturnType<StorageSafetyState["snapshot"]>[] = [];
    const result = await createSweeper({
      safetyState: state,
      config: { batchSize: 1 },
      readPhysicalUsage: () => {
        samples += 1;
        return samples === 1 ? safe : hard;
      },
      emergencyCheckpoint: () => ({
        busy: 1,
        logFrames: 9,
        checkpointedFrames: 0,
      }),
      yieldControl: async () => {
        safetyAtYield.push(state.snapshot());
      },
    }).run();

    expect(result).toMatchObject({
      success: false,
      failure: "physical_storage_critical",
      removedEvents: { age: 1, budget: 0 },
    });
    expect(safetyAtYield).toHaveLength(2);
    expect(safetyAtYield[0]).toMatchObject({
      acceptingIngest: false,
      retentionKnownSuccessful: false,
    });
    expect(safetyAtYield.at(-1)).toMatchObject({
      safety: "critical",
      acceptingIngest: false,
    });
    expect(eventIds()).toContain(second.eventRowId);
    expect(eventIds()).not.toContain(first.eventRowId);
  });

  it("samples and disables admission before yielding every terminal-redrive and delivered-outbox batch", async () => {
    const delivered = record({ fingerprint: "a" });
    const parent = record({ fingerprint: "b" });
    database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'delivered', next_attempt = NULL, delivered_at = ?, attempts = 1
         WHERE id = ?`,
      )
      .run("2026-08-20T00:00:00.000Z", delivered.outboxId);
    database
      .prepare(
        `UPDATE webhook_outbox
         SET state = 'dead_letter', next_attempt = NULL, last_error = 'failed'
         WHERE id = ?`,
      )
      .run(parent.outboxId);
    database
      .prepare(
        `INSERT INTO webhook_redrives(
           delivery_id, original_outbox_id, target_url, secret_ref, signature,
           state, attempts, requested_at, attempted_at, last_error
         ) VALUES (
           '44444444-4444-4444-8444-444444444444', ?,
           'https://code-agent.example/api/code/webhooks/sentry', 'HOOK', ?,
           'dead_letter', 1, ?, ?, 'failed'
         )`,
      )
      .run(
        parent.outboxId,
        "d".repeat(64),
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      );
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    const critical = usage({
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes,
    });
    let samples = 0;
    const safetyAtYield: ReturnType<StorageSafetyState["snapshot"]>[] = [];
    const preparedSql: string[] = [];
    const originalPrepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    });

    const result = await createSweeper({
      safetyState: state,
      config: { batchSize: 1 },
      readPhysicalUsage: () => {
        samples += 1;
        return samples === 1 ? usage() : critical;
      },
      emergencyCheckpoint: () => ({
        busy: 1,
        logFrames: 10,
        checkpointedFrames: 0,
      }),
      yieldControl: async () => {
        safetyAtYield.push(state.snapshot());
      },
    }).run();

    expect(result).toMatchObject({
      success: false,
      removedOutbox: 1,
      removedRedrives: 1,
    });
    expect(safetyAtYield).toHaveLength(3);
    expect(safetyAtYield[0]).toMatchObject({
      acceptingIngest: false,
      retentionKnownSuccessful: false,
    });
    expect(
      safetyAtYield
        .slice(1)
        .every(
          (snapshot) =>
            snapshot.safety === "critical" &&
            snapshot.acceptingIngest === false,
        ),
    ).toBe(true);
    expect(
      preparedSql.filter((sql) =>
        /SELECT received_at\s+FROM events INDEXED BY idx_events_retention_received/iu.test(
          sql,
        ),
      ),
    ).toHaveLength(samples + 2);
  });

  it("preserves a sampled physical-critical classification when emergency reclaim throws", async () => {
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    const critical = usage({
      totalBytes: DEFAULT_RETENTION_CONFIG.physicalCriticalBytes,
    });

    const result = await createSweeper({
      safetyState: state,
      readPhysicalUsage: () => critical,
      emergencyCheckpoint: () => {
        throw new Error("restart checkpoint failed");
      },
    }).run();

    expect(result).toMatchObject({ success: false, failure: "cleanup_failed" });
    expect(state.snapshot()).toMatchObject({
      safety: "critical",
      acceptingIngest: false,
      lastFailure: "cleanup_failed",
    });
  });

  it("keeps logical accounting work bounded as event batch count grows", async () => {
    for (const [index, receivedAt] of [
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ].entries()) {
      record({ fingerprint: String(index), receivedAt });
    }
    const preparedSql: string[] = [];
    const originalPrepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    });

    const result = await createSweeper({ config: { batchSize: 1 } }).run();

    expect(result).toMatchObject({
      success: true,
      removedEvents: { age: 3, budget: 0 },
      batches: 3,
    });
    expect(
      preparedSql.filter((sql) =>
        /SUM\s*\(\s*compressed_payload_bytes|MIN\s*\(\s*received_at/iu.test(
          sql,
        ),
      ),
    ).toEqual([]);
    expect(
      preparedSql.filter((sql) =>
        /WHERE id > \? AND id <= \?.*ORDER BY id.*LIMIT \?/isu.test(sql),
      ),
    ).toHaveLength(3);
  });

  it("fails closed when bounded reconciliation detects logical-accounting drift", async () => {
    record({ receivedAt: "2026-08-22T00:00:00.000Z" });
    database
      .prepare(
        `UPDATE retention_accounting
         SET logical_payload_bytes = 0
         WHERE singleton = 1`,
      )
      .run();
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);

    const result = await createSweeper({
      safetyState: state,
      config: { batchSize: 10 },
    }).run();

    expect(result).toMatchObject({ success: false, failure: "cleanup_failed" });
    expect(state.snapshot()).toMatchObject({
      safety: "unsafe",
      acceptingIngest: false,
      retentionKnownSuccessful: false,
      lastFailure: "cleanup_failed",
    });
  });

  it("drains bounded reconciliation despite insert and delete mutations between steps", async () => {
    const removed = record({
      fingerprint: "a",
      receivedAt: "2026-08-22T00:00:00.000Z",
    });
    record({ fingerprint: "b", receivedAt: "2026-08-23T00:00:00.000Z" });
    record({ fingerprint: "c", receivedAt: "2026-08-24T00:00:00.000Z" });
    const state = new StorageSafetyState(DEFAULT_RETENTION_CONFIG);
    state.observeUsage(usage(), 0, null);
    state.markSuccess(new Date(NOW), { age: 0, budget: 0 });
    const safetyDuringVerification: ReturnType<
      StorageSafetyState["snapshot"]
    >[] = [];

    const result = await createSweeper({
      safetyState: state,
      config: { batchSize: 2 },
      yieldControl: async () => {
        safetyDuringVerification.push(state.snapshot());
        if (safetyDuringVerification.length === 1) {
          record({
            fingerprint: "d",
            receivedAt: "2026-08-25T00:00:00.000Z",
          });
        } else if (safetyDuringVerification.length === 2) {
          database
            .prepare("DELETE FROM events WHERE id = ?")
            .run(removed.eventRowId);
        }
      },
    }).run();

    expect(result).toMatchObject({ success: true, batches: 0 });
    expect(safetyDuringVerification).toHaveLength(3);
    expect(
      safetyDuringVerification.every(
        (snapshot) => snapshot.acceptingIngest === false,
      ),
    ).toBe(true);
    expect(
      database
        .prepare(
          `SELECT reconciliation_cursor_id
           FROM retention_accounting
           WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({ reconciliation_cursor_id: -1 });
    expect(eventIds()).toHaveLength(3);
    expect(eventIds()).not.toContain(removed.eventRowId);
  });

  it.each(["low", "high"] as const)(
    "fails closed on multi-batch %s accounting drift before deleting in-window events",
    async (direction) => {
      record({ fingerprint: "a", receivedAt: "2026-08-22T00:00:00.000Z" });
      record({ fingerprint: "b", receivedAt: "2026-08-23T00:00:00.000Z" });
      record({ fingerprint: "c", receivedAt: "2026-08-24T00:00:00.000Z" });
      const idsBefore = eventIds();
      const config = {
        logicalHighBytes: 1_000_000,
        logicalTargetBytes: 900_000,
        physicalCriticalBytes: 2_000_000,
        physicalTotalBytes: 3_000_000,
        minimumFreeBytes: 10,
        batchSize: 1,
      };
      database
        .prepare(
          `UPDATE retention_accounting
           SET logical_payload_bytes = ?
           WHERE singleton = 1`,
        )
        .run(direction === "low" ? 0 : config.logicalHighBytes + 1);
      const state = new StorageSafetyState({
        ...DEFAULT_RETENTION_CONFIG,
        ...config,
      });

      const result = await createSweeper({
        safetyState: state,
        config,
      }).run();

      expect(result).toMatchObject({
        success: false,
        failure: "cleanup_failed",
        removedEvents: { age: 0, budget: 0 },
      });
      expect(eventIds()).toEqual(idsBefore);
      expect(state.snapshot()).toMatchObject({
        acceptingIngest: false,
        retentionKnownSuccessful: false,
        lastFailure: "cleanup_failed",
      });
    },
  );

  it("refreshes accounting after the initial async physical sample before budget cleanup", async () => {
    const config = tinyConfig();
    const state = new StorageSafetyState(config);
    const initialSample = deferred<PhysicalStorageUsage>();
    let samples = 0;
    const run = createSweeper({
      safetyState: state,
      config,
      readPhysicalUsage: () => {
        samples += 1;
        return samples === 1 ? initialSample.promise : usage();
      },
    }).run();
    await vi.waitFor(() => expect(samples).toBe(1));
    const inserted = record({ receivedAt: "2026-08-22T00:00:00.000Z" });
    setLogicalBytes([inserted], [config.logicalHighBytes + 1]);

    initialSample.resolve(usage());
    const result = await run;

    expect(result).toMatchObject({
      success: true,
      removedEvents: { age: 0, budget: 1 },
      usage: { logicalPayloadBytes: 0 },
    });
    expect(eventIds()).toEqual([]);
  });

  it("publishes post-sample accounting when an ingest commits during a per-batch await", async () => {
    const config = tinyConfig();
    const state = new StorageSafetyState(config);
    state.observeUsage(usage(), 0, null);
    state.markSuccess(new Date(NOW), { age: 0, budget: 0 });
    record({ receivedAt: "2026-07-01T00:00:00.000Z" });
    const batchSample = deferred<PhysicalStorageUsage>();
    let samples = 0;
    const safetyAtYield: ReturnType<StorageSafetyState["snapshot"]>[] = [];
    const run = createSweeper({
      safetyState: state,
      config,
      readPhysicalUsage: () => {
        samples += 1;
        return samples === 2 ? batchSample.promise : usage();
      },
      yieldControl: async () => {
        safetyAtYield.push(state.snapshot());
      },
    }).run();
    await vi.waitFor(() => expect(samples).toBe(2));
    const inserted = record({ receivedAt: "2026-08-22T00:00:00.000Z" });
    setLogicalBytes([inserted], [config.logicalHighBytes + 1]);

    batchSample.resolve(usage());
    await run;

    expect(safetyAtYield[0]).toMatchObject({
      safety: "critical",
      acceptingIngest: false,
      logicalPayloadBytes: config.logicalHighBytes + 1,
    });
  });

  it("fails closed when an ingest commits during the final async physical sample", async () => {
    const config = tinyConfig();
    const state = new StorageSafetyState(config);
    const finalSample = deferred<PhysicalStorageUsage>();
    let samples = 0;
    const run = createSweeper({
      safetyState: state,
      config,
      readPhysicalUsage: () => {
        samples += 1;
        return samples === 2 ? finalSample.promise : usage();
      },
    }).run();
    await vi.waitFor(() => expect(samples).toBe(2));
    const inserted = record({ receivedAt: "2026-08-22T00:00:00.000Z" });
    setLogicalBytes([inserted], [config.logicalHighBytes + 1]);

    finalSample.resolve(usage());
    const result = await run;

    expect(result).toMatchObject({ success: false, failure: "cleanup_failed" });
    expect(state.snapshot()).toMatchObject({
      acceptingIngest: false,
      retentionKnownSuccessful: false,
      lastFailure: "cleanup_failed",
      logicalPayloadBytes: config.logicalHighBytes + 1,
    });
    expect(eventIds()).toEqual([inserted.eventRowId]);
  });
});

function createSweeper(
  overrides: Partial<
    Omit<ConstructorParameters<typeof RetentionSweeper>[0], "operations">
  > & {
    readonly safetyState?: StorageSafetyState;
    readonly config?: Partial<typeof DEFAULT_RETENTION_CONFIG>;
  } = {},
): RetentionSweeper {
  const sweeperOverrides = { ...overrides };
  delete sweeperOverrides.safetyState;
  delete sweeperOverrides.config;
  const operations = createOperationsContext({
    ...DEFAULT_RETENTION_CONFIG,
    ...overrides.config,
  });
  const state = overrides.safetyState ?? operations.storageSafety;
  return new RetentionSweeper({
    database,
    clock: () => new Date(NOW),
    operations: { ...operations, storageSafety: state },
    readPhysicalUsage: () => usage(),
    ...sweeperOverrides,
  });
}

function tinyConfig(): RetentionConfig {
  return {
    ...DEFAULT_RETENTION_CONFIG,
    logicalHighBytes: 400,
    logicalTargetBytes: 360,
    physicalCriticalBytes: 475,
    physicalTotalBytes: 500,
    minimumFreeBytes: 10,
    batchSize: 1,
    incrementalVacuumPages: 1,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function record(
  options: {
    fingerprint?: string;
    receivedAt?: string;
    occurredAt?: string;
    level?: "warn" | "error" | "fatal";
    release?: string | null;
    service?: string | null;
  } = {},
) {
  sequence += 1;
  const event = normalizedEvent(sequence, options);
  return issues.recordOccurrence({
    projectId: 1,
    event,
    fingerprint: {
      ...FINGERPRINT,
      digest: (options.fingerprint ?? "a").repeat(64),
    },
    buildOutbox: ({ issueId, generation }) => ({
      deliveryId: `${String(sequence).padStart(8, "0")}-0000-4000-8000-${String(issueId * 100 + generation).padStart(12, "0")}`,
      mode: "live" as const,
      targetUrl: "https://code-agent.example/api/code/webhooks/sentry",
      secretRef: "HOOK",
      signature: "f".repeat(64),
      body: Buffer.from("{}"),
    }),
  });
}

function normalizedEvent(
  id: number,
  options: {
    receivedAt?: string;
    occurredAt?: string;
    level?: "warn" | "error" | "fatal";
    release?: string | null;
    service?: string | null;
  },
): NormalizedEvent {
  return {
    id: `event-${String(id)}`,
    occurredAt: options.occurredAt ?? "2026-08-28T09:00:00.000Z",
    receivedAt: options.receivedAt ?? "2026-08-28T09:00:01.000Z",
    level: options.level ?? "error",
    title: `failure ${String(id)}`,
    message: `failure ${String(id)}`,
    exception: null,
    breadcrumbs: [],
    tags: {},
    release: options.release === undefined ? "1.0.0" : options.release,
    environment: "dev",
    serverName: options.service === undefined ? "api" : options.service,
    platform: "node",
    logger: "api",
    requestId: null,
    traceId: null,
    taskId: null,
    payload: { contexts: {}, extras: {}, correlations: {} },
    payloadBytes: 100,
    truncated: false,
    truncationReasons: [],
  };
}

function setLogicalBytes(
  rows: readonly { readonly eventRowId: number }[],
  bytes: readonly number[],
): void {
  for (const [index, row] of rows.entries()) {
    database
      .prepare("UPDATE events SET compressed_payload_bytes = ? WHERE id = ?")
      .run(bytes[index] ?? 0, row.eventRowId);
  }
}

function eventIds(): number[] {
  return database
    .prepare("SELECT id FROM events ORDER BY received_at, id")
    .all()
    .map((row) => (row as { id: number }).id);
}

function usage(
  overrides: Partial<PhysicalStorageUsage> = {},
): PhysicalStorageUsage {
  return {
    databaseBytes: 100,
    walBytes: 20,
    shmBytes: 10,
    temporaryBytes: 5,
    dataDirectoryOtherBytes: 0,
    totalBytes: 135,
    freeBytes: 10 * 1024 ** 3,
    ...overrides,
  };
}
