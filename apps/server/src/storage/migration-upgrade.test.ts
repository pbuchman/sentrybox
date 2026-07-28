import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ErrorHubDatabase } from "./database.js";
import { migrateDatabase } from "./migrate.js";
import { OutboxRepository } from "./outbox-repository.js";
import { WebhookDispatcher } from "../webhooks/dispatcher.js";

const ORIGINAL_001_SHA256 =
  "a24c930f9028bf0aa20b62e6e03edf2f4d0f502d422d8ee0643fe2781230b1e3";
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
  it("keeps migration 001 byte-identical to the applied v1 artifact", () => {
    const sql = readFileSync(
      new URL("./migrations/001_initial.sql", import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      ORIGINAL_001_SHA256,
    );
  });

  it("upgrades a populated v1 database to v2 without changing historical rows", async () => {
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

    expect(database.pragma("user_version", { simple: true })).toBe(2);
    expect(
      database
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, name: "001_initial" },
      { version: 2, name: "002_webhook_delivery" },
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
    expect(database.pragma("user_version", { simple: true })).toBe(2);
  });
});

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
