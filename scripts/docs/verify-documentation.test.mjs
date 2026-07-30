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

test("reports missing inline and reference-style local Markdown images", async () => {
  await withRepository(
    {
      "docs/guide.md": [
        "![inline diagram](./missing-inline.png)",
        "![reference diagram][architecture]",
        "",
        "[architecture]: ./missing-reference.png",
      ].join("\n"),
    },
    async (root) => {
      assert.deepEqual(await validateDocumentation(root, ["docs/guide.md"]), [
        "docs/guide.md: missing local link target: ./missing-inline.png",
        "docs/guide.md: missing local link target: ./missing-reference.png",
      ]);
    },
  );
});

for (const [description, content] of [
  ["full", "See [setup][install].\n\n[install]: ./missing.md\n"],
  ["collapsed", "See [setup][].\n\n[setup]: ./missing.md\n"],
  ["shortcut", "See [setup].\n\n[setup]: ./missing.md\n"],
]) {
  test(`reports a missing ${description} reference-style Markdown link`, async () => {
    await withRepository({ "docs/guide.md": content }, async (root) => {
      assert.deepEqual(await validateDocumentation(root, ["docs/guide.md"]), [
        "docs/guide.md: missing local link target: ./missing.md",
      ]);
    });
  });
}

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
        "",
        "  ```bash",
        "  printf '%s\\n' indented",
        "  ```",
        "",
        "~~~sh",
        "printf '%s\\n' tilde",
        "~~~",
        "",
        "````bash",
        "printf '%s\\n' longer",
        "````",
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

for (const [description, source] of [
  [
    "an indented",
    ["  ```bash", "  if true; then", "  ```"].join("\n"),
  ],
  ["a tilde", ["~~~sh", "if true; then", "~~~"].join("\n")],
  ["a longer", ["````bash", "if true; then", "````"].join("\n")],
]) {
  test(`reports invalid syntax in ${description} shell fence`, async () => {
    await withRepository(
      { "docs/commands.md": source },
      async (root) => {
        assert.deepEqual(
          await validateDocumentation(root, ["docs/commands.md"]),
          ["docs/commands.md: invalid bash syntax"],
        );
      },
    );
  });
}

test("reports an unclosed fenced bash block with its source file", async () => {
  await withRepository(
    {
      "docs/commands.md": ["```bash", "if true; then"].join("\n"),
    },
    async (root) => {
      assert.deepEqual(
        await validateDocumentation(root, ["docs/commands.md"]),
        ["docs/commands.md: unclosed bash fence"],
      );
    },
  );
});

test("reports an unclosed shell fence whose body has valid bash syntax", async () => {
  await withRepository(
    {
      "docs/commands.md": ["```sh", "printf '%s\\n' ready"].join("\n"),
    },
    async (root) => {
      assert.deepEqual(
        await validateDocumentation(root, ["docs/commands.md"]),
        ["docs/commands.md: unclosed bash fence"],
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

test("rejects an affirmative not only fully Sentry-compatible claim", async () => {
  await withRepository(
    {
      "docs/claims.md":
        "SentryBox is not only fully Sentry-compatible, but also faster.\n",
    },
    async (root) => {
      assert.deepEqual(
        await validateDocumentation(root, ["docs/claims.md"]),
        ["docs/claims.md: forbidden claim: fully Sentry-compatible"],
      );
    },
  );
});

for (const [description, claim, category] of [
  [
    "not just",
    "SentryBox is not just a full Sentry replacement, but a hosted platform too.",
    "drop-in/full Sentry replacement",
  ],
  [
    "not merely",
    "SentryBox is not merely fully Sentry-compatible; it extends Sentry.",
    "fully Sentry-compatible",
  ],
]) {
  test(`rejects an affirmative ${description} Sentry claim`, async () => {
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

test("rejects a claim after an unrelated earlier negation", async () => {
  await withRepository(
    {
      "docs/claims.md":
        "It is not trivial to deploy, but fully Sentry-compatible.\n",
    },
    async (root) => {
      assert.deepEqual(
        await validateDocumentation(root, ["docs/claims.md"]),
        ["docs/claims.md: forbidden claim: fully Sentry-compatible"],
      );
    },
  );
});
