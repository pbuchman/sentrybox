import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ErrorHubDatabase } from "./database.js";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly url: URL;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "001_initial",
    url: new URL("./migrations/001_initial.sql", import.meta.url),
  },
  {
    version: 2,
    name: "002_webhook_delivery",
    url: new URL("./migrations/002_webhook_delivery.sql", import.meta.url),
  },
];

export function migrateDatabase(
  database: ErrorHubDatabase,
  appliedAt = new Date().toISOString(),
): void {
  assertTimestamp(appliedAt);
  database.exec("BEGIN EXCLUSIVE");
  try {
    for (const migration of MIGRATIONS) {
      applyMigration(database, migration, appliedAt);
    }
    const latest = MIGRATIONS.at(-1);
    if (latest === undefined)
      throw new Error("no database migrations configured");
    const unexpected = database
      .prepare(
        `SELECT version, name
         FROM schema_migrations
         WHERE version > ?
         ORDER BY version
         LIMIT 1`,
      )
      .get(latest.version) as { version: number; name: string } | undefined;
    if (unexpected !== undefined) {
      throw new Error(
        `Database migration ${unexpected.name} version ${String(unexpected.version)} is newer than this runtime`,
      );
    }
    database.pragma(`user_version = ${String(latest.version)}`);
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function applyMigration(
  database: ErrorHubDatabase,
  migration: Migration,
  appliedAt: string,
): void {
  const sql = readFileSync(migration.url, "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const existing = hasMigrationTable(database)
    ? (database
        .prepare(
          "SELECT name, checksum FROM schema_migrations WHERE version = ?",
        )
        .get(migration.version) as
        | { name: string; checksum: string }
        | undefined)
    : undefined;
  if (existing !== undefined) {
    if (existing.name !== migration.name || existing.checksum !== checksum) {
      throw new Error(
        `Migration ${migration.name} checksum does not match the applied migration`,
      );
    }
    return;
  }
  database.exec(sql);
  database
    .prepare(
      `INSERT INTO schema_migrations(version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(migration.version, migration.name, checksum, appliedAt);
}

function hasMigrationTable(database: ErrorHubDatabase): boolean {
  return (
    database
      .prepare(
        `SELECT 1
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'schema_migrations'`,
      )
      .get() !== undefined
  );
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError("migration timestamp must be an ISO timestamp");
  }
}
