import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ErrorHubDatabase } from "./database.js";

const INITIAL_MIGRATION_VERSION = 1;
const INITIAL_MIGRATION_NAME = "001_initial";
const INITIAL_MIGRATION_URL = new URL(
  "./migrations/001_initial.sql",
  import.meta.url,
);

export function migrateDatabase(
  database: ErrorHubDatabase,
  appliedAt = new Date().toISOString(),
): void {
  assertTimestamp(appliedAt);
  const sql = readFileSync(INITIAL_MIGRATION_URL, "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");

  database.exec("BEGIN EXCLUSIVE");
  try {
    database.exec(sql);
    const existing = database
      .prepare("SELECT checksum FROM schema_migrations WHERE version = ?")
      .get(INITIAL_MIGRATION_VERSION) as { checksum: string } | undefined;

    if (existing === undefined) {
      database
        .prepare(
          `INSERT INTO schema_migrations
             (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          INITIAL_MIGRATION_VERSION,
          INITIAL_MIGRATION_NAME,
          checksum,
          appliedAt,
        );
    } else if (existing.checksum !== checksum) {
      throw new Error(
        `Migration ${INITIAL_MIGRATION_NAME} checksum does not match the applied migration`,
      );
    }

    database.pragma(`user_version = ${INITIAL_MIGRATION_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError("migration timestamp must be an ISO timestamp");
  }
}
