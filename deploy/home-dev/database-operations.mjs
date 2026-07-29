import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(dependencyAnchor());
const Database = require("better-sqlite3");

const SYNTHETIC_ENVIRONMENT = "deployment-health";
const SYNTHETIC_ORIGIN = "https://deployment-health.invalid";
const SYNTHETIC_RELEASE = "error-hub-deployment-health";
const SYNTHETIC_TITLE = "Error Hub deployment health check";

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

export function prepareSyntheticPublicCheck(filename, contextPath) {
  if (existsSync(contextPath)) {
    throw new Error("synthetic public check context already exists");
  }
  const publicKey = randomBytes(32).toString("hex");
  const eventId = randomBytes(16).toString("hex");
  const database = new Database(filename, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  try {
    return database.transaction(() => {
      const project = database
        .prepare(
          "SELECT id FROM projects WHERE enabled = 1 ORDER BY id LIMIT 1",
        )
        .get();
      if (project === undefined || !Number.isSafeInteger(project.id)) {
        throw new Error("synthetic public check requires an enabled project");
      }
      const now = new Date().toISOString();
      const inserted = database
        .prepare(
          `INSERT INTO project_ingest_keys (
             project_id, environment, public_key_hash, cors_origins_json,
             forwarding_mode, forwarding_secret_ref, webhook_mode,
             webhook_target_url, webhook_secret_ref, enabled_at, created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, 'disabled', NULL, 'disabled', NULL, NULL,
                     NULL, ?, ?)`,
        )
        .run(
          project.id,
          SYNTHETIC_ENVIRONMENT,
          createHash("sha256").update(publicKey, "utf8").digest(),
          JSON.stringify([SYNTHETIC_ORIGIN]),
          now,
          now,
        );
      const projectId = Number(project.id);
      const keyId = Number(inserted.lastInsertRowid);
      const dsn = `https://${publicKey}@errors.intexuraos.cloud/${String(projectId)}`;
      const event = {
        event_id: eventId,
        environment: SYNTHETIC_ENVIRONMENT,
        release: SYNTHETIC_RELEASE,
        level: "warning",
        message: SYNTHETIC_TITLE,
        fingerprint: [SYNTHETIC_RELEASE, eventId],
      };
      const payload = JSON.stringify(event);
      const envelope = [
        JSON.stringify({
          event_id: eventId,
          dsn,
          sdk: { name: "sentry.javascript.node", version: "8.55.0" },
        }),
        JSON.stringify({ type: "event", length: Buffer.byteLength(payload) }),
        payload,
        "",
      ].join("\n");
      const context = {
        version: 1,
        keyId,
        projectId,
        publicKey,
        dsn,
        eventId,
        envelope,
      };
      writeFileSync(contextPath, `${JSON.stringify(context)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return context;
    })();
  } catch (error) {
    rmSync(contextPath, { force: true });
    throw error;
  } finally {
    database.close();
  }
}

export function verifySyntheticPublicCheck(filename, contextPath) {
  const context = syntheticContext(contextPath);
  const database = openReadonly(filename);
  try {
    const rows = database
      .prepare(
        `SELECT e.environment, e.release, e.level, e.title,
                i.status, i.occurrence_count,
                o.destination_mode, o.state, o.cause
         FROM events AS e
         INNER JOIN issues AS i
           ON i.id = e.issue_id AND i.project_id = e.project_id
         LEFT JOIN webhook_outbox AS o
           ON o.issue_id = i.id AND o.project_id = i.project_id
         WHERE e.project_id = ? AND e.event_id = ?`,
      )
      .all(context.projectId, context.eventId);
    if (rows.length !== 1) {
      throw new Error("synthetic envelope was not persisted exactly once");
    }
    const event = rows[0];
    if (
      event.environment !== SYNTHETIC_ENVIRONMENT ||
      event.release !== SYNTHETIC_RELEASE ||
      event.level !== "warn" ||
      event.title !== SYNTHETIC_TITLE ||
      event.status !== "unresolved" ||
      event.occurrence_count !== 1 ||
      event.destination_mode !== "disabled" ||
      event.state !== "suppressed" ||
      event.cause !== "created"
    ) {
      throw new Error("synthetic envelope persistence contract is invalid");
    }
  } finally {
    database.close();
  }
}

export function cleanupSyntheticPublicCheck(filename, contextPath) {
  if (!existsSync(contextPath)) return;
  const context = syntheticContext(contextPath);
  const database = new Database(filename, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  try {
    database.transaction(() => {
      const issues = database
        .prepare(
          `SELECT DISTINCT issue_id
           FROM events WHERE project_id = ? AND event_id = ?`,
        )
        .all(context.projectId, context.eventId);
      if (issues.length === 1) {
        database
          .prepare("DELETE FROM issues WHERE id = ? AND project_id = ?")
          .run(issues[0].issue_id, context.projectId);
      }
      database
        .prepare(
          `DELETE FROM project_ingest_keys
           WHERE id = ? AND project_id = ? AND environment = ?`,
        )
        .run(context.keyId, context.projectId, SYNTHETIC_ENVIRONMENT);
    })();
    rmSync(contextPath);
  } finally {
    database.close();
  }
}

function syntheticContext(contextPath) {
  const parsed = JSON.parse(readFileSync(contextPath, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.version !== 1 ||
    !Number.isSafeInteger(parsed.keyId) ||
    parsed.keyId <= 0 ||
    !Number.isSafeInteger(parsed.projectId) ||
    parsed.projectId <= 0 ||
    typeof parsed.publicKey !== "string" ||
    !/^[0-9a-f]{64}$/u.test(parsed.publicKey) ||
    typeof parsed.eventId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(parsed.eventId) ||
    typeof parsed.envelope !== "string" ||
    parsed.envelope.length === 0
  ) {
    throw new Error("synthetic public check context is invalid");
  }
  return parsed;
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
  if (command === "synthetic-prepare") {
    const context = prepareSyntheticPublicCheck(
      "/data/error-hub.sqlite",
      requiredSyntheticContextPath(),
    );
    process.stdout.write(`${JSON.stringify(context)}\n`);
    return;
  }
  if (command === "synthetic-verify") {
    verifySyntheticPublicCheck(
      "/data/error-hub.sqlite",
      requiredSyntheticContextPath(),
    );
    return;
  }
  if (command === "synthetic-cleanup") {
    cleanupSyntheticPublicCheck(
      "/data/error-hub.sqlite",
      requiredSyntheticContextPath(),
    );
    return;
  }
  throw new Error("unknown database deployment operation");
}

function requiredSyntheticContextPath() {
  const value = process.argv[3];
  if (
    typeof value !== "string" ||
    !/^\/state\/synthetic-public-check\.[0-9]+\.json$/u.test(value)
  ) {
    throw new Error("synthetic public check context path is invalid");
  }
  return value;
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
