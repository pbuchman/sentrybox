import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecretStore } from "./secrets.js";

const directories: string[] = [];
const FORWARD_VALUE = "https://legacy-public-key@o123.ingest.sentry.io/456";
const HMAC_VALUE = "code-agent-hmac-value";

afterEach(() => {
  for (const directory of directories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("credential file loader", () => {
  it("loads each named secret once without exposing values through inspection", () => {
    const path = credentialFile(
      `LEGACY_BACKEND_DEV_DSN=${FORWARD_VALUE}\nCODE_AGENT_BACKEND_DEV_HMAC=${HMAC_VALUE}\n`,
    );
    const store = loadSecretStore({
      environment: { ERROR_HUB_ENV_FILE: path },
      requiredReferences: [
        "CODE_AGENT_BACKEND_DEV_HMAC",
        "LEGACY_BACKEND_DEV_DSN",
      ],
    });
    writeFileSync(
      path,
      "LEGACY_BACKEND_DEV_DSN=changed\nCODE_AGENT_BACKEND_DEV_HMAC=changed\n",
      { mode: 0o600 },
    );

    expect(store.resolve("LEGACY_BACKEND_DEV_DSN")).toBe(FORWARD_VALUE);
    expect(store.resolve("CODE_AGENT_BACKEND_DEV_HMAC")).toBe(HMAC_VALUE);
    expect(store.references()).toEqual([
      "CODE_AGENT_BACKEND_DEV_HMAC",
      "LEGACY_BACKEND_DEV_DSN",
    ]);
    const inspected = JSON.stringify(store);
    expect(inspected).not.toContain(FORWARD_VALUE);
    expect(inspected).not.toContain(HMAC_VALUE);
    expect(Object.keys(store)).toEqual([]);
  });

  it.each([
    {
      name: "missing configured file path",
      environment: {},
      contents: null,
      required: ["LEGACY_BACKEND_DEV_DSN"],
      error: "ERROR_HUB_ENV_FILE",
    },
    {
      name: "duplicate entry",
      environment: null,
      contents: "LEGACY_BACKEND_DEV_DSN=first\nLEGACY_BACKEND_DEV_DSN=second\n",
      required: ["LEGACY_BACKEND_DEV_DSN"],
      error: "duplicate",
    },
    {
      name: "empty entry",
      environment: null,
      contents: "LEGACY_BACKEND_DEV_DSN=\n",
      required: ["LEGACY_BACKEND_DEV_DSN"],
      error: "empty",
    },
    {
      name: "missing required reference",
      environment: null,
      contents: "CODE_AGENT_BACKEND_DEV_HMAC=value\n",
      required: ["CODE_AGENT_BACKEND_DEV_HMAC", "LEGACY_BACKEND_DEV_DSN"],
      error: "LEGACY_BACKEND_DEV_DSN",
    },
    {
      name: "unreferenced entry",
      environment: null,
      contents:
        "LEGACY_BACKEND_DEV_DSN=value\nUNREFERENCED_SECRET=must-not-load\n",
      required: ["LEGACY_BACKEND_DEV_DSN"],
      error: "UNREFERENCED_SECRET",
    },
    {
      name: "non KEY=VALUE line",
      environment: null,
      contents: "LEGACY_BACKEND_DEV_DSN value\n",
      required: ["LEGACY_BACKEND_DEV_DSN"],
      error: "KEY=VALUE",
    },
  ])(
    "fails closed for $name and never includes credential values",
    ({ environment, contents, required, error }) => {
      const path = contents === null ? null : credentialFile(String(contents));
      const actualEnvironment =
        environment ?? (path === null ? {} : { ERROR_HUB_ENV_FILE: path });

      let thrown: unknown;
      try {
        loadSecretStore({
          environment: actualEnvironment,
          requiredReferences: required,
        });
      } catch (caught) {
        thrown = caught;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = String(thrown);
      expect(message.toLowerCase()).toContain(error.toLowerCase());
      expect(message).not.toContain("must-not-load");
      expect(message).not.toContain(FORWARD_VALUE);
      expect(message).not.toContain(HMAC_VALUE);
    },
  );

  it("rejects resolution of every name not declared at startup", () => {
    const path = credentialFile("LEGACY_BACKEND_DEV_DSN=value\n");
    const store = loadSecretStore({
      environment: { ERROR_HUB_ENV_FILE: path },
      requiredReferences: ["LEGACY_BACKEND_DEV_DSN"],
    });

    expect(() => store.resolve("NOT_DECLARED")).toThrow("not configured");
  });
});

function credentialFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "error-hub-secrets-"));
  directories.push(directory);
  const path = join(directory, "env");
  writeFileSync(path, contents, { mode: 0o600 });
  expect(readFileSync(path, "utf8")).toBe(contents);
  return path;
}
