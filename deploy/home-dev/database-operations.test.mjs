import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createOnlineBackup,
  validatePreflightDatabase,
  validateRollbackDatabase,
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
  database.exec(`
    CREATE TABLE projects(id INTEGER PRIMARY KEY);
    CREATE TABLE project_ingest_keys(
      project_id INTEGER NOT NULL,
      environment TEXT NOT NULL,
      public_key_hash BLOB NOT NULL
    );
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO projects(id) VALUES (1), (2);
    INSERT INTO project_ingest_keys(project_id, environment, public_key_hash)
    VALUES
      (1, 'dev',  X'01'),
      (1, 'prod', X'02'),
      (2, 'dev',  X'03'),
      (2, 'prod', X'04');
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
