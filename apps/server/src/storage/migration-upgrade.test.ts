import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listIssues } from "../api/read-model.js";
import { parseFilters } from "../api/query.js";
import { openDatabase, type ErrorHubDatabase } from "./database.js";
import { migrateDatabase } from "./migrate.js";
import { OutboxRepository } from "./outbox-repository.js";
import { WebhookDispatcher } from "../webhooks/dispatcher.js";
import { createOperationsContext } from "../operations.js";

const ORIGINAL_001_SHA256 =
  "a24c930f9028bf0aa20b62e6e03edf2f4d0f502d422d8ee0643fe2781230b1e3";
const ORIGINAL_002_SHA256 =
  "13f0e90064b78ef7727d139869f0bace45e54c499cee94c0c2bfbc9c7a4debb9";
const ORIGINAL_003_SHA256 =
  "7acf5bea95bc10e9ea33a028574d03b7b4463bea4a27750970a09f4b73ad6310";
const ORIGINAL_004_SHA256 =
  "7a496732e2bdd1c3d232c213f7337e8b76b6dbead1eaa0b5cea6fc0e3b236614";
const APPLIED_AT = "2026-07-28T10:00:00.000Z";
const directories: string[] = [];
const databases: ErrorHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const directory of directories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ordered database migration upgrade", () => {
  it("keeps historical migrations byte-identical to their applied artifacts", () => {
    expect(migrationChecksum("001_initial.sql")).toBe(ORIGINAL_001_SHA256);
    expect(migrationChecksum("002_webhook_delivery.sql")).toBe(
      ORIGINAL_002_SHA256,
    );
    expect(migrationChecksum("003_due_frontier.sql")).toBe(ORIGINAL_003_SHA256);
    expect(migrationChecksum("004_private_api_order.sql")).toBe(
      ORIGINAL_004_SHA256,
    );
  });

  it("upgrades a populated v1 database through v5 without changing historical rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "error-hub-v1-upgrade-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "error-hub.sqlite"));
    databases.push(database);
    const initialSql = readFileSync(
      new URL("./migrations/001_initial.sql", import.meta.url),
      "utf8",
    );
    database.exec(initialSql);
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES (1, '001_initial', ?, ?)`,
      )
      .run(ORIGINAL_001_SHA256, APPLIED_AT);
    database.pragma("user_version = 1");
    insertV1Rows(database);
    const before = historicalRows(database);

    migrateDatabase(database, "2026-07-28T10:05:00.000Z");

    expect(database.pragma("user_version", { simple: true })).toBe(5);
    expect(
      database
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, name: "001_initial" },
      { version: 2, name: "002_webhook_delivery" },
      { version: 3, name: "003_due_frontier" },
      { version: 4, name: "004_private_api_order" },
      { version: 5, name: "005_retention_indexes" },
    ]);
    expect(historicalRows(database)).toEqual(before);
    const outbox = new OutboxRepository(database);
    expect(outbox.getById(1)).toMatchObject({
      body: Buffer.from('{"action":"triggered"}'),
      signature: null,
      dispatchLeaseId: null,
      dispatchLeaseUntil: null,
    });
    const send = vi.fn(async () => ({ statusCode: 204 }));
    const dispatcher = new WebhookDispatcher({
      outbox,
      operations: createOperationsContext(),
      http: { send },
      now: () => new Date(APPLIED_AT),
      requestTimeoutMs: 2_000,
      leaseMs: 10_000,
      createLeaseId: () => "upgrade-lease",
    });
    await expect(dispatcher.dispatchDue()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      retried: 0,
      deadLettered: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getById(1)).toMatchObject({
      state: "dead_letter",
      attempts: 1,
      lastError: "invalid destination configuration",
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'webhook_redrives'",
        )
        .get(),
    ).toEqual({ name: "webhook_redrives" });
    expect(() =>
      database
        .prepare(
          `INSERT INTO webhook_redrives(
             delivery_id, original_outbox_id, target_url, secret_ref,
             signature, state, requested_at
           ) VALUES (?, 999, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          "5c48723a-29e3-4661-b1c4-6c5d23fcfd07",
          "https://code-agent.example/api/code/webhooks/sentry",
          "CODE_AGENT_HMAC_BACKEND_DEV",
          "a".repeat(64),
          APPLIED_AT,
        ),
    ).toThrow();

    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2")
      .run("0".repeat(64));
    expect(() => migrateDatabase(database, "2026-07-28T10:06:00.000Z")).toThrow(
      /002_webhook_delivery checksum/u,
    );
    expect(database.pragma("user_version", { simple: true })).toBe(5);
  });

  it("upgrades populated v2 to v5 with indexed bounded dispatcher, private API, and retention frontiers", () => {
    const directory = mkdtempSync(join(tmpdir(), "error-hub-v2-upgrade-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "error-hub.sqlite"));
    databases.push(database);
    const initialSql = readFileSync(
      new URL("./migrations/001_initial.sql", import.meta.url),
      "utf8",
    );
    const webhookDeliverySql = readFileSync(
      new URL("./migrations/002_webhook_delivery.sql", import.meta.url),
      "utf8",
    );
    database.exec(initialSql);
    insertV1Rows(database);
    database.exec(webhookDeliverySql);
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES (1, '001_initial', ?, ?),
                (2, '002_webhook_delivery', ?, ?)`,
      )
      .run(ORIGINAL_001_SHA256, APPLIED_AT, ORIGINAL_002_SHA256, APPLIED_AT);
    database.pragma("user_version = 2");
    const before = database
      .prepare("SELECT * FROM webhook_outbox ORDER BY id")
      .all();

    migrateDatabase(database, "2026-07-28T10:07:00.000Z");

    expect(database.pragma("user_version", { simple: true })).toBe(5);
    expect(
      database
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, name: "001_initial" },
      { version: 2, name: "002_webhook_delivery" },
      { version: 3, name: "003_due_frontier" },
      { version: 4, name: "004_private_api_order" },
      { version: 5, name: "005_retention_indexes" },
    ]);
    expect(
      database.prepare("SELECT * FROM webhook_outbox ORDER BY id").all(),
    ).toEqual(before);
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, next_attempt, created_at, attempts,
                dispatch_lease_until
         FROM webhook_outbox INDEXED BY idx_webhook_outbox_due_frontier
         WHERE state IN ('pending', 'retry') AND next_attempt <= ?
         ORDER BY next_attempt, id
         LIMIT ?`,
      )
      .all(APPLIED_AT, 25) as { detail: string }[];
    expect(plan.map((step) => step.detail).join("\n")).toMatch(
      /SEARCH webhook_outbox USING INDEX idx_webhook_outbox_due_frontier \(next_attempt<\?\)/u,
    );
    expectPrivateApiPlans(database);
    expectRetentionPlans(database);
  });

  it("upgrades populated v3 to v5 without changing rows and adds operation indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "error-hub-v3-upgrade-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "error-hub.sqlite"));
    databases.push(database);
    database.exec(migrationSql("001_initial.sql"));
    insertV1Rows(database);
    database.exec(migrationSql("002_webhook_delivery.sql"));
    database.exec(migrationSql("003_due_frontier.sql"));
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES (1, '001_initial', ?, ?),
                (2, '002_webhook_delivery', ?, ?),
                (3, '003_due_frontier', ?, ?)`,
      )
      .run(
        ORIGINAL_001_SHA256,
        APPLIED_AT,
        ORIGINAL_002_SHA256,
        APPLIED_AT,
        ORIGINAL_003_SHA256,
        APPLIED_AT,
      );
    database.pragma("user_version = 3");
    const before = historicalRows(database);

    migrateDatabase(database, "2026-07-28T10:08:00.000Z");

    expect(database.pragma("user_version", { simple: true })).toBe(5);
    expect(historicalRows(database)).toEqual(before);
    expect(
      database
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, name: "001_initial" },
      { version: 2, name: "002_webhook_delivery" },
      { version: 3, name: "003_due_frontier" },
      { version: 4, name: "004_private_api_order" },
      { version: 5, name: "005_retention_indexes" },
    ]);
    expectPrivateApiPlans(database);
    expectRetentionPlans(database);
  });

  it("upgrades populated v4 to v5 without changing rows and adds only retention indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "error-hub-v4-upgrade-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "error-hub.sqlite"));
    databases.push(database);
    database.exec(migrationSql("001_initial.sql"));
    insertV1Rows(database);
    for (const name of [
      "002_webhook_delivery.sql",
      "003_due_frontier.sql",
      "004_private_api_order.sql",
    ]) {
      database.exec(migrationSql(name));
    }
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at)
         VALUES (1, '001_initial', ?, ?),
                (2, '002_webhook_delivery', ?, ?),
                (3, '003_due_frontier', ?, ?),
                (4, '004_private_api_order', ?, ?)`,
      )
      .run(
        ORIGINAL_001_SHA256,
        APPLIED_AT,
        ORIGINAL_002_SHA256,
        APPLIED_AT,
        ORIGINAL_003_SHA256,
        APPLIED_AT,
        ORIGINAL_004_SHA256,
        APPLIED_AT,
      );
    database.pragma("user_version = 4");
    const before = historicalRows(database);

    migrateDatabase(database, "2026-07-28T10:09:00.000Z");

    expect(database.pragma("user_version", { simple: true })).toBe(5);
    expect(historicalRows(database)).toEqual(before);
    expectRetentionPlans(database);
  });
});

function migrationSql(name: string): string {
  return readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
}

function migrationChecksum(name: string): string {
  return createHash("sha256").update(migrationSql(name)).digest("hex");
}

function expectPrivateApiPlans(database: ErrorHubDatabase): void {
  const exportPlan = database
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, occurred_at, event_id, payload_gzip
       FROM events
       ORDER BY occurred_at, event_id, id
       LIMIT ?`,
    )
    .all(25) as { detail: string }[];
  expect(exportPlan.map((step) => step.detail).join("\n")).toMatch(
    /USING INDEX idx_events_export_order/u,
  );
  for (const shape of [
    {
      index: "idx_issues_last_seen",
      status: [] as string[],
      parameters: [26] as unknown[],
    },
    {
      index: "idx_issues_status_last_seen",
      status: ["unresolved"],
      parameters: ["unresolved", 26],
    },
    {
      index: "idx_issues_last_seen",
      status: ["unresolved", "resolved"],
      parameters: [26] as unknown[],
    },
  ]) {
    const productionQuery = captureProductionIssueList(database, shape.status);
    expect(productionQuery.parameters).toEqual(shape.parameters);
    if (shape.status.length === 1) {
      expect(productionQuery.sql).toMatch(
        /\)\s+AND i\.status = \?\s+ORDER BY i\.last_seen DESC/u,
      );
    }
    const issuePlanText = productionQuery.plan
      .map((step) => step.detail)
      .join("\n");
    expect(issuePlanText).toContain(`USING INDEX ${shape.index}`);
    expect(issuePlanText).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/u);
  }
}

function expectRetentionPlans(database: ErrorHubDatabase): void {
  for (const [sql, parameters, index] of [
    [
      `SELECT id, issue_id FROM events INDEXED BY idx_events_retention_received
       WHERE received_at < ?
       ORDER BY received_at, id
       LIMIT ?`,
      [APPLIED_AT, 25],
      "idx_events_retention_received",
    ],
    [
      `SELECT id FROM webhook_outbox INDEXED BY idx_outbox_retention_delivered
       WHERE state = 'delivered' AND delivered_at < ?
       ORDER BY delivered_at, id
       LIMIT ?`,
      [APPLIED_AT, 25],
      "idx_outbox_retention_delivered",
    ],
    [
      `SELECT id FROM webhook_redrives INDEXED BY idx_webhook_redrives_retention_terminal
       WHERE state IN ('delivered', 'dead_letter') AND attempted_at < ?
       ORDER BY attempted_at, id
       LIMIT ?`,
      [APPLIED_AT, 25],
      "idx_webhook_redrives_retention_terminal",
    ],
  ] as const) {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters) as { detail: string }[];
    expect(plan.map((step) => step.detail).join("\n")).toContain(index);
  }
}

function captureProductionIssueList(
  database: ErrorHubDatabase,
  status: readonly string[],
): {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly plan: { readonly detail: string }[];
} {
  let capturedSql: string | null = null;
  let capturedParameters: readonly unknown[] = [];
  const capturingDatabase = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return {
        all(...parameters: unknown[]) {
          capturedSql = sql;
          capturedParameters = parameters;
          return statement.all(...parameters);
        },
      };
    },
  } as unknown as ErrorHubDatabase;
  listIssues(capturingDatabase, parseFilters({ status }), 25, null);
  if (capturedSql === null) throw new Error("issue list SQL was not captured");
  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${capturedSql}`)
    .all(...capturedParameters) as { detail: string }[];
  return { sql: capturedSql, parameters: capturedParameters, plan };
}

function insertV1Rows(database: ErrorHubDatabase): void {
  database
    .prepare(
      `INSERT INTO projects(id, slug, name, enabled, created_at, updated_at)
       VALUES (1, 'intexuraos-backend', 'Backend', 1, ?, ?)`,
    )
    .run(APPLIED_AT, APPLIED_AT);
  database
    .prepare(
      `INSERT INTO issues(
         id, project_id, fingerprint_version, fingerprint,
         fingerprint_explanation_json, title, status, generation,
         occurrence_count, first_seen, last_seen, last_received_at,
         highest_level, resolved_at, created_at, updated_at
       ) VALUES (
         1, 1, 1, ?, '[]', 'failure', 'unresolved', 1,
         1, ?, ?, ?, 'error', NULL, ?, ?
       )`,
    )
    .run(
      "a".repeat(64),
      APPLIED_AT,
      APPLIED_AT,
      APPLIED_AT,
      APPLIED_AT,
      APPLIED_AT,
    );
  database
    .prepare(
      `INSERT INTO webhook_outbox(
         id, delivery_id, project_id, issue_id, event_id, generation, cause,
         destination_mode, target_url, secret_ref, body, state, attempts,
         next_attempt, last_error, created_at, delivered_at
       ) VALUES (
         1, '1be9b1ba-83ca-4df6-8644-71f93eadcf35', 1, 1, 'event-1', 1,
         'created', 'live', 'https://code-agent.example/api/code/webhooks/sentry',
         'CODE_AGENT_HMAC_BACKEND_DEV', ?, 'pending', 0, ?, NULL, ?, NULL
       )`,
    )
    .run(Buffer.from('{"action":"triggered"}'), APPLIED_AT, APPLIED_AT);
}

function historicalRows(database: ErrorHubDatabase): unknown {
  return {
    projects: database.prepare("SELECT * FROM projects ORDER BY id").all(),
    issues: database.prepare("SELECT * FROM issues ORDER BY id").all(),
    outbox: database
      .prepare(
        `SELECT id, delivery_id, project_id, issue_id, event_id, generation,
                cause, destination_mode, target_url, secret_ref, body, state,
                attempts, next_attempt, last_error, created_at, delivered_at
         FROM webhook_outbox ORDER BY id`,
      )
      .all(),
  };
}
