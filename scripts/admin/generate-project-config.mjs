import { Buffer } from "node:buffer";
import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import {
  validateDeliveryTransition,
  validateProjectConfiguration,
} from "./validate-project-config.mjs";

const require = createRequire(moduleAnchor());
const Database = require("better-sqlite3");

export function openAdminDatabase(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new TypeError("database filename must not be empty");
  }
  const database = new Database(filename, {
    fileMustExist: filename !== ":memory:",
  });
  try {
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function applyProjectConfiguration(options) {
  const configuration = validateProjectConfiguration(options.configuration);
  const createdAt = timestamp(options.createdAt, "project creation timestamp");
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const generated = generatePublicKeys(configuration.ingestKeys, randomBytes);
  const transaction = options.database.transaction(() => {
    assertConfigurationSchema(options.database);
    assertUnconfigured(options.database);
    const insertProject = options.database.prepare(
      `INSERT INTO projects
         (id, slug, name, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    for (const project of configuration.projects) {
      insertProject.run(
        project.id,
        project.slug,
        project.name,
        createdAt,
        createdAt,
      );
    }
    const insertKey = options.database.prepare(
      `INSERT INTO project_ingest_keys (
         project_id, environment, public_key_hash, cors_origins_json,
         forwarding_mode, forwarding_secret_ref, webhook_mode,
         webhook_target_url, webhook_secret_ref, enabled_at, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'disabled', NULL, NULL, NULL, ?, ?)`,
    );
    for (const key of configuration.ingestKeys) {
      const publicKey = generated.get(key.id);
      if (publicKey === undefined) {
        throw new Error("generated public key is unavailable");
      }
      insertKey.run(
        key.projectId,
        key.environment,
        hashPublicKey(publicKey),
        JSON.stringify(key.allowedOrigins),
        key.forwarding.mode,
        key.forwarding.mode === "shadow" ? key.forwarding.secretRef : null,
        createdAt,
        createdAt,
      );
    }
  });
  transaction();

  const projectsById = new Map(
    configuration.projects.map((project) => [project.id, project]),
  );
  return {
    dsns: configuration.ingestKeys.map((key) => {
      const project = projectsById.get(key.projectId);
      const publicKey = generated.get(key.id);
      if (project === undefined || publicKey === undefined) {
        throw new Error("generated DSN context is unavailable");
      }
      return {
        id: key.id,
        project: project.slug,
        environment: key.environment,
        dsn: buildDsn(configuration.publicBaseUrl, project.id, publicKey),
      };
    }),
  };
}

export function enableCodeAgentDestinations(options) {
  const configuration = validateProjectConfiguration(options.configuration);
  const enabledAt = timestamp(
    options.enabledAt,
    "Code Agent baseline timestamp",
  );
  const transaction = options.database.transaction(() => {
    assertConfigurationSchema(options.database);
    const select = options.database.prepare(
      `SELECT webhook_mode, enabled_at
       FROM project_ingest_keys
       WHERE project_id = ? AND environment = ?`,
    );
    for (const key of configuration.ingestKeys) {
      const current = select.get(key.projectId, key.environment);
      if (current === undefined) {
        throw new Error("configured ingest key is missing");
      }
      validateDeliveryTransition({
        from: current.webhook_mode,
        to: "live",
        enabledAt,
      });
    }
    validateStoredProjectConfiguration({
      database: options.database,
      configuration,
      expectedWebhookMode: "disabled",
    });
    const update = options.database.prepare(
      `UPDATE project_ingest_keys
       SET webhook_mode = 'live', webhook_target_url = ?,
           webhook_secret_ref = ?, enabled_at = ?, updated_at = ?
       WHERE project_id = ? AND environment = ? AND webhook_mode = 'disabled'`,
    );
    for (const key of configuration.ingestKeys) {
      const result = update.run(
        key.codeAgent.targetUrl,
        key.codeAgent.secretRef,
        enabledAt,
        enabledAt,
        key.projectId,
        key.environment,
      );
      if (result.changes !== 1) {
        throw new Error("Code Agent destination transition was not applied");
      }
    }
  });
  transaction();
}

export function disableCodeAgentDestinations(options) {
  const configuration = validateProjectConfiguration(options.configuration);
  const disabledAt = timestamp(
    options.disabledAt,
    "Code Agent disable timestamp",
  );
  const transaction = options.database.transaction(() => {
    assertConfigurationSchema(options.database);
    const select = options.database.prepare(
      `SELECT webhook_mode, enabled_at
       FROM project_ingest_keys
       WHERE project_id = ? AND environment = ?`,
    );
    const baselines = new Set();
    for (const key of configuration.ingestKeys) {
      const current = select.get(key.projectId, key.environment);
      if (current === undefined) {
        throw new Error("configured ingest key is missing");
      }
      validateDeliveryTransition({
        from: current.webhook_mode,
        to: "disabled",
        enabledAt: null,
      });
      if (current.webhook_mode !== "live" || current.enabled_at === null) {
        throw new Error("Code Agent destination is not live");
      }
      baselines.add(current.enabled_at);
    }
    if (baselines.size !== 1) {
      throw new Error("live Code Agent destinations do not share one baseline");
    }
    const [baseline] = baselines;
    validateStoredProjectConfiguration({
      database: options.database,
      configuration,
      expectedWebhookMode: "live",
      enabledAt: baseline,
    });
    const update = options.database.prepare(
      `UPDATE project_ingest_keys
       SET webhook_mode = 'disabled', webhook_target_url = NULL,
           webhook_secret_ref = NULL, enabled_at = NULL, updated_at = ?
       WHERE project_id = ? AND environment = ? AND webhook_mode = 'live'`,
    );
    for (const key of configuration.ingestKeys) {
      const result = update.run(disabledAt, key.projectId, key.environment);
      if (result.changes !== 1) {
        throw new Error("Code Agent destination disable was not applied");
      }
    }
  });
  transaction();
}

export function validateStoredProjectConfiguration(options) {
  const configuration = validateProjectConfiguration(options.configuration);
  const expectedMode = enumValue(
    options.expectedWebhookMode,
    ["disabled", "live"],
    "expected webhook mode",
  );
  const expectedEnabledAt =
    options.enabledAt === undefined
      ? null
      : timestamp(options.enabledAt, "expected Code Agent baseline");
  if (expectedMode === "disabled" && expectedEnabledAt !== null) {
    throw new TypeError("disabled validation cannot include a baseline");
  }
  if (expectedMode === "live" && expectedEnabledAt === null) {
    throw new TypeError("live validation requires the expected baseline");
  }
  assertConfigurationSchema(options.database);
  const projects = options.database
    .prepare(
      `SELECT id, slug, name, enabled
       FROM projects
       ORDER BY id`,
    )
    .all();
  if (projects.length !== configuration.projects.length) {
    throw new Error("stored project count does not match configuration");
  }
  const expectedProjects = new Map(
    configuration.projects.map((project) => [project.id, project]),
  );
  for (const row of projects) {
    const expected = expectedProjects.get(row.id);
    if (
      expected === undefined ||
      row.slug !== expected.slug ||
      row.name !== expected.name ||
      row.enabled !== 1
    ) {
      throw new Error("stored project does not match configuration");
    }
  }

  const rows = options.database
    .prepare(
      `SELECT project_id, environment, public_key_hash, cors_origins_json,
              forwarding_mode, forwarding_secret_ref, webhook_mode,
              webhook_target_url, webhook_secret_ref, enabled_at
       FROM project_ingest_keys
       ORDER BY project_id, environment`,
    )
    .all();
  if (rows.length !== configuration.ingestKeys.length) {
    throw new Error("stored ingest key count does not match configuration");
  }
  const hashes = new Set();
  const expectedKeys = new Map(
    configuration.ingestKeys.map((key) => [
      `${String(key.projectId)}\0${key.environment}`,
      key,
    ]),
  );
  for (const row of rows) {
    const key = expectedKeys.get(
      `${String(row.project_id)}\0${row.environment}`,
    );
    if (key === undefined) {
      throw new Error("stored ingest key is not configured");
    }
    if (
      !Buffer.isBuffer(row.public_key_hash) ||
      row.public_key_hash.length !== 32
    ) {
      throw new Error("stored ingest key hash is invalid");
    }
    const hash = row.public_key_hash.toString("hex");
    if (hashes.has(hash)) {
      throw new Error("stored ingest key hashes are not unique");
    }
    hashes.add(hash);
    if (
      row.cors_origins_json !== JSON.stringify(key.allowedOrigins) ||
      row.forwarding_mode !== key.forwarding.mode ||
      row.forwarding_secret_ref !==
        (key.forwarding.mode === "shadow" ? key.forwarding.secretRef : null) ||
      row.webhook_mode !== expectedMode
    ) {
      throw new Error("stored ingest key does not match configuration");
    }
    if (expectedMode === "disabled") {
      if (
        row.webhook_target_url !== null ||
        row.webhook_secret_ref !== null ||
        row.enabled_at !== null
      ) {
        throw new Error("disabled Code Agent destination contains live state");
      }
    } else if (
      row.webhook_target_url !== key.codeAgent.targetUrl ||
      row.webhook_secret_ref !== key.codeAgent.secretRef ||
      row.enabled_at !== expectedEnabledAt
    ) {
      throw new Error(
        "live Code Agent destination does not match configuration",
      );
    }
  }
}

function generatePublicKeys(keys, randomBytes) {
  const generated = new Map();
  const seen = new Set();
  for (const key of keys) {
    const bytes = randomBytes(16);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
      throw new TypeError("public key generator must return 16 bytes");
    }
    const publicKey = bytes.toString("hex");
    if (seen.has(publicKey)) {
      throw new Error("duplicate generated public key");
    }
    seen.add(publicKey);
    generated.set(key.id, publicKey);
  }
  return generated;
}

function hashPublicKey(publicKey) {
  return createHash("sha256").update(publicKey, "utf8").digest();
}

function buildDsn(publicBaseUrl, projectId, publicKey) {
  const dsn = new URL(publicBaseUrl);
  dsn.username = publicKey;
  dsn.pathname = `/${String(projectId)}`;
  return dsn.toString().replace(/\/$/u, "");
}

function assertConfigurationSchema(database) {
  for (const table of ["projects", "project_ingest_keys"]) {
    const row = database
      .prepare(
        `SELECT 1 AS present
         FROM sqlite_schema
         WHERE type = 'table' AND name = ?`,
      )
      .get(table);
    if (row === undefined) {
      throw new Error(
        "Error Hub database migrations must run before project configuration",
      );
    }
  }
}

function assertUnconfigured(database) {
  const projects = database
    .prepare("SELECT count(*) AS count FROM projects")
    .get();
  const keys = database
    .prepare("SELECT count(*) AS count FROM project_ingest_keys")
    .get();
  if (projects.count !== 0 || keys.count !== 0) {
    throw new Error(
      "project configuration already exists; implicit DSN rotation is forbidden",
    );
  }
}

function timestamp(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function enumValue(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function moduleAnchor() {
  const workspacePackage = new URL(
    "../../apps/server/package.json",
    import.meta.url,
  );
  return existsSync(fileURLToPath(workspacePackage))
    ? workspacePackage
    : new URL("../../package.json", import.meta.url);
}

function parseArguments(argv) {
  let database = null;
  let config = null;
  let enableCodeAgentAt = null;
  let disableCodeAgentAt = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === "--database") database = value;
    else if (flag === "--config") config = value;
    else if (flag === "--enable-code-agent-at") enableCodeAgentAt = value;
    else if (flag === "--disable-code-agent-at") disableCodeAgentAt = value;
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (database === null) throw new Error("--database is required");
  if (config === null) throw new Error("--config is required");
  if (enableCodeAgentAt !== null && disableCodeAgentAt !== null) {
    throw new Error("enable and disable actions are mutually exclusive");
  }
  return { database, config, enableCodeAgentAt, disableCodeAgentAt };
}

function isDirectExecution() {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

async function runCli() {
  const args = parseArguments(process.argv.slice(2));
  const configuration = JSON.parse(readFileSync(args.config, "utf8"));
  const database = openAdminDatabase(args.database);
  try {
    if (args.enableCodeAgentAt !== null) {
      enableCodeAgentDestinations({
        database,
        configuration,
        enabledAt: args.enableCodeAgentAt,
      });
      process.stdout.write(
        `Code Agent destinations enabled at ${new Date(args.enableCodeAgentAt).toISOString()}.\n`,
      );
      return;
    }
    if (args.disableCodeAgentAt !== null) {
      disableCodeAgentDestinations({
        database,
        configuration,
        disabledAt: args.disableCodeAgentAt,
      });
      process.stdout.write(
        `Code Agent destinations disabled at ${new Date(args.disableCodeAgentAt).toISOString()}.\n`,
      );
      return;
    }
    const result = applyProjectConfiguration({
      database,
      configuration,
      createdAt: new Date().toISOString(),
    });
    process.stdout.write(
      "Generated DSNs (only clear-text output; store them now):\n",
    );
    for (const entry of result.dsns) {
      process.stdout.write(`${entry.id}=${entry.dsn}\n`);
    }
  } finally {
    database.close();
  }
}

if (isDirectExecution()) {
  void runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Project configuration generation failed"}\n`,
    );
    process.exitCode = 1;
  });
}
