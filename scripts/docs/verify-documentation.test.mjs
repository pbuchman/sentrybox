import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  findDocumentationFiles,
  validateDocumentation,
} from "./verify-documentation.mjs";

async function withRepository(files, check) {
  const root = await mkdtemp(join(tmpdir(), "sentrybox-documentation-"));
  try {
    await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        const destination = join(root, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, "utf8");
      }),
    );
    await check(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("accepts a valid relative Markdown link", async () => {
  await withRepository(
    {
      "docs/guide.md": "See [setup](./setup.md).\n",
      "docs/setup.md": "# Setup\n",
    },
    async (root) => {
      assert.deepEqual(await validateDocumentation(root, ["docs/guide.md"]), []);
    },
  );
});

test("reports a missing local Markdown link with its source file", async () => {
  await withRepository(
    { "docs/guide.md": "See [setup](./missing.md).\n" },
    async (root) => {
      assert.deepEqual(await validateDocumentation(root, ["docs/guide.md"]), [
        "docs/guide.md: missing local link target: ./missing.md",
      ]);
    },
  );
});

test("accepts syntactically valid fenced bash and sh blocks", async () => {
  await withRepository(
    {
      "docs/commands.md": [
        "```bash",
        "printf '%s\\n' hello",
        "```",
        "",
        "```sh",
        "if true; then echo ready; fi",
        "```",
      ].join("\n"),
    },
    async (root) => {
      assert.deepEqual(
        await validateDocumentation(root, ["docs/commands.md"]),
        [],
      );
    },
  );
});

test("reports invalid fenced bash syntax with its source file", async () => {
  await withRepository(
    {
      "docs/commands.md": ["```bash", "if true; then", "```"].join("\n"),
    },
    async (root) => {
      assert.deepEqual(
        await validateDocumentation(root, ["docs/commands.md"]),
        ["docs/commands.md: invalid bash syntax"],
      );
    },
  );
});

test("reports an unclosed fenced bash block with its source file", async () => {
  await withRepository(
    {
      "docs/commands.md": ["```bash", "if true; then"].join("\n"),
    },
    async (root) => {
      assert.deepEqual(
        await validateDocumentation(root, ["docs/commands.md"]),
        ["docs/commands.md: invalid bash syntax"],
      );
    },
  );
});

test("ignores external and fragment-only links", async () => {
  await withRepository(
    {
      "docs/links.md": [
        "[website](https://example.com/missing)",
        "[section](#missing-section)",
      ].join("\n"),
    },
    async (root) => {
      assert.deepEqual(await validateDocumentation(root, ["docs/links.md"]), []);
    },
  );
});

test("scans README and docs while excluding docs/archive", async () => {
  await withRepository(
    {
      "README.md": "# SentryBox\n",
      "docs/current.md": "# Current\n",
      "docs/archive/obsolete.md": "[broken](./missing.md)\n",
    },
    async (root) => {
      assert.deepEqual(await findDocumentationFiles(root), [
        "README.md",
        "docs/current.md",
      ]);
      assert.deepEqual(
        await validateDocumentation(root, await findDocumentationFiles(root)),
        [],
      );
    },
  );
});

for (const [category, claim] of [
  ["drop-in/full Sentry replacement", "a drop-in Sentry replacement"],
  ["fully Sentry-compatible", "fully Sentry-compatible"],
  ["built-in/native MCP", "built-in MCP support"],
  ["same grouping as Sentry", "the same grouping as Sentry"],
  ["guaranteed 30-day history", "guaranteed 30-day history"],
  ["hard 5 GiB total limit", "a 5 GiB total limit"],
]) {
  test(`rejects the ${category} claim`, async () => {
    await withRepository(
      { "docs/claims.md": `${claim}\n` },
      async (root) => {
        assert.deepEqual(
          await validateDocumentation(root, ["docs/claims.md"]),
          [`docs/claims.md: forbidden claim: ${category}`],
        );
      },
    );
  });
}

for (const [category, correctiveLanguage] of [
  [
    "drop-in/full Sentry replacement",
    "SentryBox is not a drop-in Sentry replacement.",
  ],
  ["fully Sentry-compatible", "SentryBox is not fully Sentry-compatible."],
  ["built-in/native MCP", "SentryBox does not include built-in MCP."],
  [
    "same grouping as Sentry",
    "SentryBox does not use the same grouping as Sentry.",
  ],
  [
    "guaranteed 30-day history",
    "SentryBox does not guarantee 30-day history.",
  ],
  ["hard 5 GiB total limit", "SentryBox does not impose a 5 GiB total limit."],
]) {
  test(`permits corrective language about ${category}`, async () => {
    await withRepository(
      { "docs/claims.md": `${correctiveLanguage}\n` },
      async (root) => {
        assert.deepEqual(
          await validateDocumentation(root, ["docs/claims.md"]),
          [],
        );
      },
    );
  });
}
