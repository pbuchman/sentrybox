import { createRequire } from "node:module";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(dependencyAnchor());
const Database = require("better-sqlite3");

export function validatePreflightDatabase(filename) {
  const database = openReadonly(filename);
  try {
    assertIntegrity(database);
    const projects = database
      .prepare("SELECT COUNT(*) AS total FROM projects")
      .get();
    const keys = database
      .prepare(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT printf('%d:%s', project_id, environment)) AS pairs,
                COUNT(DISTINCT hex(public_key_hash)) AS hashes
         FROM project_ingest_keys`,
      )
      .get();
    if (
      projects.total !== 2 ||
      keys.total !== 4 ||
      keys.pairs !== 4 ||
      keys.hashes !== 4
    ) {
      throw new Error(
        "project/environment credentials are not the required unique matrix",
      );
    }
  } finally {
    database.close();
  }
}

export async function createOnlineBackup(source, destination) {
  const database = openReadonly(source);
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
}

export function validateRollbackDatabase(filename, currentMigrationVersion) {
  if (
    !Number.isSafeInteger(currentMigrationVersion) ||
    currentMigrationVersion < 1
  ) {
    throw new TypeError("current migration version must be a positive integer");
  }
  const database = openReadonly(filename);
  try {
    assertIntegrity(database);
    const migration = database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get();
    if (migration.version > currentMigrationVersion) {
      throw new Error("database migration is newer than the rollback runtime");
    }
  } finally {
    database.close();
  }
}

function openReadonly(filename) {
  return new Database(filename, {
    readonly: true,
    fileMustExist: true,
  });
}

function assertIntegrity(database) {
  const result = database.pragma("integrity_check");
  if (result.length !== 1 || result[0].integrity_check !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
}

function dependencyAnchor() {
  const workspaceAnchor = new URL(
    "../../apps/server/package.json",
    import.meta.url,
  );
  return existsSync(fileURLToPath(workspaceAnchor))
    ? workspaceAnchor
    : pathToFileURL(join(process.cwd(), "package.json"));
}

async function runCli() {
  const command = process.argv[2];
  if (command === "runtime-write") {
    const filename = "/data/.container-preflight";
    writeFileSync(filename, "ok", { encoding: "utf8", mode: 0o600 });
    rmSync(filename);
    return;
  }
  if (command === "preflight") {
    validatePreflightDatabase("/data/error-hub.sqlite");
    return;
  }
  if (command === "online-backup") {
    await createOnlineBackup(
      "/data/error-hub.sqlite",
      "/backup/.predeploy.sqlite.tmp",
    );
    return;
  }
  if (command === "open-runtime" || command === "compatibility-read") {
    const { openDatabase } = await import(
      pathToFileURL(join(process.cwd(), "dist/src/storage/database.js")).href
    );
    const database = openDatabase("/probe/migration-probe.sqlite");
    try {
      if (command === "compatibility-read") {
        database.prepare("SELECT 1 FROM projects LIMIT 1").get();
        database.prepare("SELECT 1 FROM issues LIMIT 1").get();
        database.prepare("SELECT 1 FROM events LIMIT 1").get();
      }
    } finally {
      database.close();
    }
    return;
  }
  if (command === "rollback-integrity") {
    const { CURRENT_MIGRATION_VERSION } = await import(
      pathToFileURL(join(process.cwd(), "dist/src/storage/migrate.js")).href
    );
    validateRollbackDatabase(
      "/data/error-hub.sqlite",
      CURRENT_MIGRATION_VERSION,
    );
    return;
  }
  throw new Error("unknown database deployment operation");
}

function isDirectExecution() {
  if (process.argv[1] === "-") return true;
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

if (isDirectExecution()) {
  void runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "database deployment operation failed"}\n`,
    );
    process.exitCode = 1;
  });
}
