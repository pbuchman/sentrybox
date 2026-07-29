import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { URL } from "node:url";

import {
  applyProjectConfiguration,
  disableCodeAgentDestinations,
  enableCodeAgentDestinations,
  openAdminDatabase,
  validateStoredProjectConfiguration,
} from "./generate-project-config.mjs";
import {
  validateDeliveryTransition,
  validateProjectConfiguration,
} from "./validate-project-config.mjs";

const CREATED_AT = "2026-07-28T12:00:00.000Z";
const ENABLED_AT = "2026-07-28T13:00:00.000Z";
const CONFIG = JSON.parse(
  readFileSync(
    new URL("../../deploy/home-dev/config.example.json", import.meta.url),
    "utf8",
  ),
);

test("the canonical configuration defines two projects and four environment-bound keys", () => {
  const configuration = validateProjectConfiguration(CONFIG);

  assert.deepEqual(
    configuration.projects.map(({ slug }) => slug),
    ["intexuraos-backend", "intexuraos-web"],
  );
  assert.deepEqual(
    configuration.ingestKeys.map(({ id }) => id),
    [
      "intexuraos-backend-dev",
      "intexuraos-backend-prod",
      "intexuraos-web-dev",
      "intexuraos-web-prod",
    ],
  );
});

test("duplicate project IDs, slugs, key IDs, and project/environment pairs are rejected", () => {
  for (const mutate of [
    (copy) => {
      copy.projects[1].id = copy.projects[0].id;
    },
    (copy) => {
      copy.projects[1].slug = copy.projects[0].slug;
    },
    (copy) => {
      copy.ingestKeys[1].id = copy.ingestKeys[0].id;
    },
    (copy) => {
      copy.ingestKeys[1].projectId = copy.ingestKeys[0].projectId;
      copy.ingestKeys[1].environment = copy.ingestKeys[0].environment;
    },
  ]) {
    const copy = clone(CONFIG);
    mutate(copy);
    assert.throws(() => validateProjectConfiguration(copy), /duplicate/u);
  }
});

test("a key identity cannot disagree with its project or environment", () => {
  const copy = clone(CONFIG);
  copy.ingestKeys[0].environment = "prod";

  assert.throws(
    () => validateProjectConfiguration(copy),
    /key identity.*environment/u,
  );
});

test("every key requires a non-empty exact browser-origin allowlist", () => {
  const copy = clone(CONFIG);
  copy.ingestKeys[0].allowedOrigins = [];

  assert.throws(() => validateProjectConfiguration(copy), /allowedOrigins/u);
});

test("legacy forwarding and Code Agent destinations cannot cross environments", () => {
  const forwarding = clone(CONFIG);
  forwarding.ingestKeys[0].forwarding.environment = "prod";
  assert.throws(
    () => validateProjectConfiguration(forwarding),
    /forwarding environment/u,
  );

  const codeAgent = clone(CONFIG);
  codeAgent.ingestKeys[0].codeAgent.environment = "prod";
  assert.throws(
    () => validateProjectConfiguration(codeAgent),
    /Code Agent environment/u,
  );
});

test("Code Agent delivery starts disabled and live activation requires an immutable baseline", () => {
  assert.throws(
    () =>
      validateDeliveryTransition({
        from: "disabled",
        to: "live",
        enabledAt: null,
      }),
    /baseline timestamp/u,
  );
  assert.throws(
    () =>
      validateDeliveryTransition({
        from: "disabled",
        to: "disabled",
        enabledAt: ENABLED_AT,
      }),
    /disabled.*timestamp/u,
  );
  assert.throws(
    () =>
      validateDeliveryTransition({
        from: "live",
        to: "live",
        enabledAt: ENABLED_AT,
      }),
    /already live/u,
  );
  assert.deepEqual(
    validateDeliveryTransition({
      from: "disabled",
      to: "live",
      enabledAt: ENABLED_AT,
    }),
    { from: "disabled", to: "live", enabledAt: ENABLED_AT },
  );
});

test("generation inserts only four unique key hashes and never persists clear DSNs", () => {
  const database = fixtureDatabase();
  const keys = [
    Buffer.alloc(16, 1),
    Buffer.alloc(16, 2),
    Buffer.alloc(16, 3),
    Buffer.alloc(16, 4),
  ];

  const result = applyProjectConfiguration({
    database,
    configuration: CONFIG,
    createdAt: CREATED_AT,
    randomBytes: () => keys.shift(),
  });

  assert.equal(result.dsns.length, 4);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM projects").get().count,
    2,
  );
  const stored = database
    .prepare(
      `SELECT public_key_hash, webhook_mode, webhook_target_url,
              webhook_secret_ref, enabled_at
       FROM project_ingest_keys
       ORDER BY id`,
    )
    .all();
  assert.equal(stored.length, 4);
  assert.equal(
    new Set(
      stored.map(({ public_key_hash }) => public_key_hash.toString("hex")),
    ).size,
    4,
  );
  assert.ok(
    stored.every(({ public_key_hash }) => public_key_hash.length === 32),
  );
  assert.ok(stored.every(({ webhook_mode }) => webhook_mode === "disabled"));
  assert.ok(
    stored.every(({ webhook_target_url }) => webhook_target_url === null),
  );
  assert.ok(
    stored.every(({ webhook_secret_ref }) => webhook_secret_ref === null),
  );
  assert.ok(stored.every(({ enabled_at }) => enabled_at === null));
  for (const { dsn } of result.dsns) {
    const clearKey = new URL(dsn).username;
    assert.ok(clearKey.length > 0);
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
           FROM project_ingest_keys
           WHERE CAST(public_key_hash AS TEXT) LIKE ?`,
        )
        .get(`%${clearKey}%`).count,
      0,
    );
  }
  assert.doesNotThrow(() =>
    validateStoredProjectConfiguration({
      database,
      configuration: CONFIG,
      expectedWebhookMode: "disabled",
    }),
  );
  database.close();
});

test("duplicate generated keys abort the entire configuration transaction", () => {
  const database = fixtureDatabase();

  assert.throws(
    () =>
      applyProjectConfiguration({
        database,
        configuration: CONFIG,
        createdAt: CREATED_AT,
        randomBytes: () => Buffer.alloc(16, 7),
      }),
    /duplicate generated public key/u,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM projects").get().count,
    0,
  );
  database.close();
});

test("the CLI prints generated DSNs once and never reveals them on a retry", () => {
  const directory = mkdtempSync(join(tmpdir(), "error-hub-project-config-"));
  const databasePath = join(directory, "error-hub.sqlite");
  writeFileSync(databasePath, "", { mode: 0o600 });
  const database = openAdminDatabase(databasePath);
  database.exec(
    readFileSync(
      new URL(
        "../../apps/server/src/storage/migrations/001_initial.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  database.close();
  const command = [
    new URL("./generate-project-config.mjs", import.meta.url).pathname,
    "--database",
    databasePath,
    "--config",
    new URL("../../deploy/home-dev/config.example.json", import.meta.url)
      .pathname,
  ];
  try {
    const generated = spawnSync(process.execPath, command, {
      encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /Generated DSNs/u);
    for (const key of CONFIG.ingestKeys) {
      assert.equal(
        generated.stdout.split(`${key.id}=`).length - 1,
        1,
        `${key.id} must appear exactly once`,
      );
    }

    const retry = spawnSync(process.execPath, command, { encoding: "utf8" });
    assert.equal(retry.status, 1);
    assert.equal(retry.stdout, "");
    assert.match(retry.stderr, /implicit DSN rotation is forbidden/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live activation atomically uses the environment-bound target and one explicit baseline", () => {
  const database = fixtureDatabase();
  let byte = 10;
  applyProjectConfiguration({
    database,
    configuration: CONFIG,
    createdAt: CREATED_AT,
    randomBytes: () => Buffer.alloc(16, byte++),
  });

  enableCodeAgentDestinations({
    database,
    configuration: CONFIG,
    enabledAt: ENABLED_AT,
  });

  const rows = database
    .prepare(
      `SELECT environment, webhook_mode, webhook_target_url,
              webhook_secret_ref, enabled_at
       FROM project_ingest_keys
       ORDER BY project_id, environment`,
    )
    .all();
  assert.ok(rows.every(({ webhook_mode }) => webhook_mode === "live"));
  assert.ok(rows.every(({ enabled_at }) => enabled_at === ENABLED_AT));
  assert.equal(
    rows.find(({ environment }) => environment === "dev").webhook_target_url,
    "https://dev.intexuraos.cloud/api/code/webhooks/sentry",
  );
  assert.equal(
    rows.find(({ environment }) => environment === "prod").webhook_target_url,
    "https://intexuraos.cloud/api/code/webhooks/sentry",
  );
  assert.throws(
    () =>
      enableCodeAgentDestinations({
        database,
        configuration: CONFIG,
        enabledAt: "2026-07-28T14:00:00.000Z",
      }),
    /already live/u,
  );
  assert.doesNotThrow(() =>
    validateStoredProjectConfiguration({
      database,
      configuration: CONFIG,
      expectedWebhookMode: "live",
      enabledAt: ENABLED_AT,
    }),
  );
  disableCodeAgentDestinations({
    database,
    configuration: CONFIG,
    disabledAt: "2026-07-28T15:00:00.000Z",
  });
  assert.doesNotThrow(() =>
    validateStoredProjectConfiguration({
      database,
      configuration: CONFIG,
      expectedWebhookMode: "disabled",
    }),
  );
  database.close();
});

function fixtureDatabase() {
  const database = openAdminDatabase(":memory:");
  database.exec(
    readFileSync(
      new URL(
        "../../apps/server/src/storage/migrations/001_initial.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return database;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
