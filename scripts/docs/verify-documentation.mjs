import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FORBIDDEN_CLAIMS = [
  [
    "drop-in/full Sentry replacement",
    /\b(?:drop-in|full)\s+sentry\s+replacement\b/iu,
  ],
  ["fully Sentry-compatible", /\bfully\s+sentry-compatible\b/iu],
  ["built-in/native MCP", /\b(?:built-in|native)\s+MCP\b/iu],
  ["same grouping as Sentry", /\bsame\s+grouping\s+as\s+Sentry\b/iu],
  ["guaranteed 30-day history", /\bguaranteed\s+30-day\s+history\b/iu],
  ["hard 5 GiB total limit", /\b5\s+GiB\s+total\s+limit\b/iu],
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
      if (expression.test(content)) {
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
  const blocks = content.matchAll(/^```(?:bash|sh)\s*\n([\s\S]*?)^```\s*$/gmu);
  for (const block of blocks) {
    if (spawnSync("bash", ["-n"], { input: block[1], encoding: "utf8" }).status !== 0) {
      return false;
    }
  }
  return true;
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
