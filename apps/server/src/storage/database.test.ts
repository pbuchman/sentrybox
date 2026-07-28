import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type ErrorHubDatabase } from "./database.js";
import { migrateDatabase } from "./migrate.js";
import {
  hashPublicKey,
  matchesPublicKeyHash,
  ProjectRepository,
} from "./project-repository.js";

const temporaryDirectories: string[] = [];
const openConnections: ErrorHubDatabase[] = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "error-hub-storage-"));
  temporaryDirectories.push(directory);
  return join(directory, "error-hub.sqlite");
}

function openTemporaryDatabase(): ErrorHubDatabase {
  const database = openDatabase(temporaryDatabasePath());
  openConnections.push(database);
  return database;
}

afterEach(() => {
  for (const database of openConnections.splice(0).reverse()) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SQLite database and migrations", () => {
  it("applies every connection pragma and the initial migration idempotently", () => {
    const path = temporaryDatabasePath();
    const first = openDatabase(path);
    openConnections.push(first);
    migrateDatabase(first, "2026-07-28T10:00:00.000Z");
    migrateDatabase(first, "2026-07-28T10:01:00.000Z");

    expect(pragmaScalar(first, "journal_mode")).toBe("wal");
    expect(pragmaScalar(first, "foreign_keys")).toBe(1);
    expect(pragmaScalar(first, "busy_timeout")).toBe(5_000);
    expect(pragmaScalar(first, "auto_vacuum")).toBe(2);
    expect(pragmaScalar(first, "wal_autocheckpoint")).toBe(1_000);
    expect(
      first.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 1 });

    first.close();
    openConnections.pop();
    const second = openDatabase(path);
    openConnections.push(second);
    expect(pragmaScalar(second, "journal_mode")).toBe("wal");
    expect(pragmaScalar(second, "foreign_keys")).toBe(1);
    expect(pragmaScalar(second, "busy_timeout")).toBe(5_000);
    expect(pragmaScalar(second, "auto_vacuum")).toBe(2);
    expect(pragmaScalar(second, "wal_autocheckpoint")).toBe(1_000);
  });

  it("creates the complete schema, foreign keys, unique keys, and query indexes", () => {
    const database = openTemporaryDatabase();
    migrateDatabase(database, "2026-07-28T10:00:00.000Z");

    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual([
      "event_tags",
      "events",
      "issue_facets",
      "issues",
      "project_ingest_keys",
      "projects",
      "schema_migrations",
      "webhook_outbox",
    ]);

    expect(foreignKeys(database, "project_ingest_keys")).toEqual([
      "project_id->projects.id:CASCADE",
    ]);
    expect(foreignKeys(database, "issues")).toEqual([
      "project_id->projects.id:CASCADE",
    ]);
    expect(foreignKeys(database, "events")).toEqual([
      "issue_id,project_id->issues.id,project_id:CASCADE",
      "project_id->projects.id:CASCADE",
    ]);
    expect(foreignKeys(database, "event_tags")).toEqual([
      "event_row_id->events.id:CASCADE",
    ]);
    expect(foreignKeys(database, "issue_facets")).toEqual([
      "issue_id->issues.id:CASCADE",
    ]);
    expect(foreignKeys(database, "webhook_outbox")).toEqual([
      "issue_id,project_id->issues.id,project_id:CASCADE",
    ]);

    expect(uniqueColumnSets(database, "project_ingest_keys")).toEqual(
      expect.arrayContaining(["project_id,environment", "public_key_hash"]),
    );
    expect(uniqueColumnSets(database, "issues")).toEqual(
      expect.arrayContaining([
        "id,project_id",
        "project_id,fingerprint_version,fingerprint",
      ]),
    );
    expect(uniqueColumnSets(database, "events")).toContain(
      "project_id,event_id",
    );
    expect(uniqueColumnSets(database, "event_tags")).toContain(
      "event_row_id,tag_key",
    );
    expect(uniqueColumnSets(database, "issue_facets")).toContain(
      "issue_id,facet_type,facet_value,facet_value_is_null",
    );
    expect(uniqueColumnSets(database, "webhook_outbox")).toEqual(
      expect.arrayContaining(["delivery_id", "issue_id,generation"]),
    );

    expect(namedIndexes(database)).toEqual(
      expect.arrayContaining([
        "idx_event_tags_lookup",
        "idx_events_issue_occurred",
        "idx_events_project_environment_received",
        "idx_events_project_level_received",
        "idx_events_project_received",
        "idx_events_project_release_received",
        "idx_events_project_service_received",
        "idx_issue_facets_lookup",
        "idx_issues_project_last_seen",
        "idx_issues_project_status_last_seen",
        "idx_outbox_dispatch",
        "idx_outbox_issue_created",
      ]),
    );
  });

  it("enforces project/environment key boundaries without storing clear keys", () => {
    const database = openTemporaryDatabase();
    migrateDatabase(database, "2026-07-28T10:00:00.000Z");
    const projects = new ProjectRepository(database);
    projects.create({
      id: 1,
      slug: "intexuraos-backend",
      name: "IntexuraOS Backend",
      enabled: true,
      createdAt: "2026-07-28T10:00:00.000Z",
    });
    projects.setIngestKey({
      projectId: 1,
      environment: "dev",
      publicKey: "backend-dev-public-key",
      allowedOrigins: [],
      forwardingMode: "disabled",
      forwardingSecretRef: null,
      webhookMode: "live",
      webhookTargetUrl: "https://code-agent.example/api/code/webhooks/sentry",
      webhookSecretRef: "CODE_AGENT_HMAC_BACKEND_DEV",
      enabledAt: "2026-07-28T10:00:00.000Z",
    });

    const stored = database
      .prepare(
        "SELECT public_key_hash, cors_origins_json FROM project_ingest_keys",
      )
      .get() as { public_key_hash: Buffer; cors_origins_json: string };
    expect(stored.public_key_hash).toEqual(
      hashPublicKey("backend-dev-public-key"),
    );
    expect(stored.public_key_hash).toHaveLength(32);
    expect(JSON.stringify(stored)).not.toContain("backend-dev-public-key");
    expect(
      matchesPublicKeyHash(stored.public_key_hash, "backend-dev-public-key"),
    ).toBe(true);
    expect(matchesPublicKeyHash(stored.public_key_hash, "wrong-key")).toBe(
      false,
    );
    expect(
      matchesPublicKeyHash(Buffer.alloc(31), "backend-dev-public-key"),
    ).toBe(false);

    expect(projects.verifyIngestKey(1, "backend-dev-public-key")).toMatchObject(
      {
        projectId: 1,
        projectSlug: "intexuraos-backend",
        environment: "dev",
        enabled: true,
        webhookMode: "live",
      },
    );
    expect(projects.verifyIngestKey(1, "wrong-key")).toBeNull();
    expect(projects.verifyIngestKey(2, "backend-dev-public-key")).toBeNull();

    expect(() =>
      projects.setIngestKey({
        projectId: 999,
        environment: "dev",
        publicKey: "orphan",
        allowedOrigins: [],
        forwardingMode: "disabled",
        forwardingSecretRef: null,
        webhookMode: "disabled",
        webhookTargetUrl: null,
        webhookSecretRef: null,
        enabledAt: null,
      }),
    ).toThrow();
  });
});

function pragmaScalar(
  database: ErrorHubDatabase,
  pragma: string,
): string | number {
  const row = database.pragma(pragma, { simple: true });
  if (typeof row !== "string" && typeof row !== "number") {
    throw new TypeError(`Unexpected PRAGMA ${pragma} result`);
  }
  return row;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

function foreignKeys(database: ErrorHubDatabase, table: string): string[] {
  const rows = database.pragma(`foreign_key_list(${table})`) as ForeignKeyRow[];
  const grouped = new Map<
    number,
    { table: string; from: string[]; to: string[]; onDelete: string }
  >();
  for (const row of rows) {
    const group = grouped.get(row.id) ?? {
      table: row.table,
      from: [],
      to: [],
      onDelete: row.on_delete,
    };
    group.from[row.seq] = row.from;
    group.to[row.seq] = row.to;
    grouped.set(row.id, group);
  }
  return [...grouped.values()]
    .map(
      (group) =>
        `${group.from.join(",")}->${group.table}.${group.to.join(",")}:${group.onDelete}`,
    )
    .sort();
}

interface IndexListRow {
  name: string;
  unique: 0 | 1;
}

function uniqueColumnSets(database: ErrorHubDatabase, table: string): string[] {
  const indexes = database.pragma(`index_list(${table})`) as IndexListRow[];
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) => {
      const columns = database.pragma(`index_info(${index.name})`) as {
        seqno: number;
        name: string;
      }[];
      return columns
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
        .join(",");
    });
}

function namedIndexes(database: ErrorHubDatabase): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}
