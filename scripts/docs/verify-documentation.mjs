import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FORBIDDEN_CLAIMS = [
  [
    "drop-in/full Sentry replacement",
    /\b(?:drop-in|full)\s+sentry\s+replacement\b/giu,
  ],
  ["fully Sentry-compatible", /\bfully\s+sentry-compatible\b/giu],
  ["built-in/native MCP", /\b(?:built-in|native)\s+MCP\b/giu],
  ["same grouping as Sentry", /\bsame\s+grouping\s+as\s+Sentry\b/giu],
  ["guaranteed 30-day history", /\bguaranteed\s+30-day\s+history\b/giu],
  ["hard 5 GiB total limit", /\b5\s+GiB\s+total\s+limit\b/giu],
];

export async function findDocumentationFiles(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const files = [];
  const readme = resolve(root, "README.md");

  if (await fileExists(readme)) files.push("README.md");
  await walkMarkdownFiles(resolve(root, "docs"), root, files);
  return files.sort();
}

export async function validateDocumentation(repositoryRoot, markdownFiles) {
  const root = resolve(repositoryRoot);
  const diagnostics = [];

  for (const file of markdownFiles) {
    const path = resolve(root, file);
    const displayPath = relative(root, path);
    const content = await readFile(path, "utf8");

    for (const target of markdownLinkTargets(content)) {
      if (isIgnoredLink(target)) continue;
      const targetPath = target.split(/[?#]/u, 1)[0];
      if (!(await fileExists(resolve(dirname(path), targetPath)))) {
        diagnostics.push(
          `${displayPath}: missing local link target: ${target}`,
        );
      }
    }

    if (!hasValidBashSyntax(content)) {
      diagnostics.push(`${displayPath}: invalid bash syntax`);
    }

    for (const [category, expression] of FORBIDDEN_CLAIMS) {
      if (hasUnqualifiedClaim(content, expression)) {
        diagnostics.push(`${displayPath}: forbidden claim: ${category}`);
      }
    }
  }

  return diagnostics;
}

async function walkMarkdownFiles(directory, root, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (path === resolve(root, "docs/archive")) continue;
      await walkMarkdownFiles(path, root, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relative(root, path));
    }
  }
}

function markdownLinkTargets(content) {
  return [...content.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/gu)].map(
    (match) => match[1].replace(/^<|>$/gu, ""),
  );
}

function isIgnoredLink(target) {
  return target.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target);
}

function hasValidBashSyntax(content) {
  let block;
  for (const line of content.split(/\r?\n/u)) {
    if (block === undefined) {
      if (/^```(?:bash|sh)\s*$/iu.test(line)) block = [];
    } else if (/^```\s*$/u.test(line)) {
      if (!isValidBash(block.join("\n"))) return false;
      block = undefined;
    } else {
      block.push(line);
    }
  }
  return block === undefined || isValidBash(block.join("\n"));
}

function isValidBash(source) {
  return spawnSync("bash", ["-n"], { input: source, encoding: "utf8" }).status === 0;
}

function hasUnqualifiedClaim(content, expression) {
  for (const match of content.matchAll(expression)) {
    if (!isExplicitlyNegated(content, match.index)) return true;
  }
  return false;
}

function isExplicitlyNegated(content, index) {
  const context = content.slice(
    Math.max(
      content.lastIndexOf("\n", index),
      content.lastIndexOf(".", index),
      content.lastIndexOf("!", index),
      content.lastIndexOf("?", index),
      content.lastIndexOf(";", index),
    ) + 1,
    index,
  );
  return /\b(?:not|never|without|no)\b|\b(?:do|does|did|is|are|was|were|can|could|should|would|will|has|have|had)n't\b/iu.test(
    context,
  );
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const root = process.argv[2] ?? process.cwd();
  const diagnostics = await validateDocumentation(
    root,
    await findDocumentationFiles(root),
  );
  if (diagnostics.length === 0) return;
  process.stderr.write(`${diagnostics.join("\n")}\n`);
  process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
