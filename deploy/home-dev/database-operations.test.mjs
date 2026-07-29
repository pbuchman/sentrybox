import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupSyntheticPublicCheck,
  createOnlineBackup,
  prepareSyntheticPublicCheck,
  validatePreflightDatabase,
  validateRollbackDatabase,
  verifySyntheticPublicCheck,
} from "./database-operations.mjs";

const require = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const Database = require("better-sqlite3");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "error-hub-deploy-db-"));
  const databasePath = join(directory, "error-hub.sqlite");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY, slug TEXT NOT NULL,
      name TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE TABLE project_ingest_keys(
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      environment TEXT NOT NULL, public_key_hash BLOB NOT NULL,
      cors_origins_json TEXT NOT NULL, forwarding_mode TEXT NOT NULL,
      forwarding_secret_ref TEXT, webhook_mode TEXT NOT NULL,
      webhook_target_url TEXT, webhook_secret_ref TEXT, enabled_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE issues(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, occurrence_count INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
    CREATE TABLE events(id INTEGER PRIMARY KEY, event_id TEXT NOT NULL,
      issue_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
      environment TEXT NOT NULL, release TEXT, level TEXT NOT NULL,
      title TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
    CREATE TABLE webhook_outbox(id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
      destination_mode TEXT NOT NULL, state TEXT NOT NULL, cause TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
    INSERT INTO projects(id, slug, name, enabled, created_at, updated_at)
    VALUES
      (1, 'intexuraos-backend', 'IntexuraOS Backend', 1, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'),
      (2, 'intexuraos-web', 'IntexuraOS Web', 1, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z');
    INSERT INTO project_ingest_keys(
      project_id, environment, public_key_hash, cors_origins_json,
      forwarding_mode, forwarding_secret_ref, webhook_mode,
      webhook_target_url, webhook_secret_ref, enabled_at, created_at, updated_at
    )
    VALUES
      (1, 'dev',  X'0101010101010101010101010101010101010101010101010101010101010101', '[]', 'disabled', NULL, 'disabled', NULL, NULL, NULL, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'),
      (1, 'prod', X'0202020202020202020202020202020202020202020202020202020202020202', '[]', 'disabled', NULL, 'disabled', NULL, NULL, NULL, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'),
      (2, 'dev',  X'0303030303030303030303030303030303030303030303030303030303030303', '[]', 'disabled', NULL, 'disabled', NULL, NULL, NULL, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'),
      (2, 'prod', X'0404040404040404040404040404040404040404040404040404040404040404', '[]', 'disabled', NULL, 'disabled', NULL, NULL, NULL, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z');
    INSERT INTO schema_migrations(version) VALUES (1), (2), (3);
  `);
  return { directory, databasePath, database };
}

test("preflight accepts exactly two projects and four unique environment credentials", () => {
  const current = fixture();
  try {
    current.database.close();
    assert.doesNotThrow(() => validatePreflightDatabase(current.databasePath));
  } finally {
    if (current.database.open) current.database.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("preflight rejects duplicate project/environment and public-key identities", () => {
  const current = fixture();
  try {
    current.database
      .prepare(
        "UPDATE project_ingest_keys SET environment = 'dev', public_key_hash = X'01' WHERE project_id = 1 AND environment = 'prod'",
      )
      .run();
    current.database.close();
    assert.throws(
      () => validatePreflightDatabase(current.databasePath),
      /credentials are not the required unique matrix/u,
    );
  } finally {
    if (current.database.open) current.database.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("online backup includes committed WAL data in a readable snapshot", async () => {
  const current = fixture();
  const backupPath = join(current.directory, "backup.sqlite");
  try {
    current.database.exec(
      "CREATE TABLE backup_probe(value TEXT NOT NULL); INSERT INTO backup_probe(value) VALUES ('retained')",
    );
    await createOnlineBackup(current.databasePath, backupPath);
    current.database.close();
    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.deepEqual(backup.prepare("SELECT value FROM backup_probe").get(), {
        value: "retained",
      });
    } finally {
      backup.close();
    }
  } finally {
    if (current.database.open) current.database.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("rollback validation rejects a migration newer than the previous runtime", () => {
  const current = fixture();
  try {
    current.database.close();
    assert.doesNotThrow(() =>
      validateRollbackDatabase(current.databasePath, 3),
    );
    assert.throws(
      () => validateRollbackDatabase(current.databasePath, 2),
      /newer than the rollback runtime/u,
    );
  } finally {
    if (current.database.open) current.database.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test("synthetic public check uses an isolated non-production key, verifies persistence, and cleans every row", () => {
  const current = fixture();
  const contextPath = join(current.directory, "synthetic-public-check.json");
  try {
    const context = prepareSyntheticPublicCheck(
      current.databasePath,
      contextPath,
    );
    assert.equal(context.projectId, 1);
    assert.equal(
      context.dsn,
      `https://${context.publicKey}@errors.intexuraos.cloud/1`,
    );
    assert.match(context.publicKey, /^[0-9a-f]{64}$/u);
    assert.match(context.eventId, /^[0-9a-f]{32}$/u);
    assert.match(context.envelope, /deployment-health/u);
    assert.deepEqual(
      current.database
        .prepare(
          "SELECT forwarding_mode, webhook_mode FROM project_ingest_keys WHERE id = ?",
        )
        .get(context.keyId),
      { forwarding_mode: "disabled", webhook_mode: "disabled" },
    );

    current.database
      .prepare(
        `INSERT INTO issues(
           id, project_id, title, status, occurrence_count
         ) VALUES (99, 1, ?, 'unresolved', 1)`,
      )
      .run("SentryBox deployment health check");
    current.database
      .prepare(
        `INSERT INTO events(
           id, event_id, issue_id, project_id, environment, release, level,
           title
         ) VALUES (99, ?, 99, 1, 'deployment-health',
                   'sentrybox-deployment-health', 'warn',
                   'SentryBox deployment health check')`,
      )
      .run(context.eventId);
    current.database
      .prepare(
        `INSERT INTO webhook_outbox(
           id, issue_id, project_id, destination_mode, state, cause
         ) VALUES (99, 99, 1, 'disabled', 'suppressed', 'created')`,
      )
      .run();

    assert.doesNotThrow(() =>
      verifySyntheticPublicCheck(current.databasePath, contextPath),
    );
    cleanupSyntheticPublicCheck(current.databasePath, contextPath);
    assert.deepEqual(
      current.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM project_ingest_keys WHERE environment = 'deployment-health') AS keys,
             (SELECT COUNT(*) FROM events WHERE id = 99) AS events,
             (SELECT COUNT(*) FROM webhook_outbox WHERE id = 99) AS outbox`,
        )
        .get(),
      { keys: 0, events: 0, outbox: 0 },
    );
  } finally {
    if (current.database.open) current.database.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});
