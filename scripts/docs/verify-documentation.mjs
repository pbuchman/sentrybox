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

    const bashDiagnostic = bashFenceDiagnostic(content);
    if (bashDiagnostic !== null) {
      diagnostics.push(`${displayPath}: ${bashDiagnostic}`);
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
  const targets = [];
  for (const match of content.matchAll(
    /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+[^)]*)?\)/gu,
  )) {
    if (isEscaped(content, match.index)) continue;
    targets.push({ index: match.index, target: match[1] ?? match[2] });
  }

  const definitions = new Map();
  for (const match of content.matchAll(
    /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|([^\s]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gmu,
  )) {
    definitions.set(referenceLabel(match[1]), match[2] ?? match[3]);
  }

  for (const match of content.matchAll(
    /!?\[([^\]\r\n]+)\](?:\[([^\]\r\n]*)\])?/gu,
  )) {
    if (isEscaped(content, match.index)) continue;
    const end = match.index + match[0].length;
    if (content[end] === "(") continue;
    const lineStart = content.lastIndexOf("\n", match.index) + 1;
    if (
      content[end] === ":" &&
      /^[ \t]{0,3}$/u.test(content.slice(lineStart, match.index))
    ) {
      continue;
    }
    const label = referenceLabel(
      match[2] === undefined || match[2].length === 0 ? match[1] : match[2],
    );
    const target = definitions.get(label);
    if (target !== undefined) targets.push({ index: match.index, target });
  }

  return targets
    .sort((left, right) => left.index - right.index)
    .map(({ target }) => target);
}

function referenceLabel(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function isEscaped(content, index) {
  let backslashes = 0;
  for (let cursor = index - 1; content[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isIgnoredLink(target) {
  return target.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target);
}

function bashFenceDiagnostic(content) {
  let block;
  for (const line of content.split(/\r?\n/u)) {
    if (block === undefined) {
      const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
      if (opening === null) continue;
      block = {
        character: opening[2][0],
        indentation: opening[1].length,
        length: opening[2].length,
        shell: /^(?:bash|sh)\s*$/iu.test(opening[3]),
        source: [],
      };
      continue;
    }

    const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(line);
    if (
      closing !== null &&
      closing[2][0] === block.character &&
      closing[2].length >= block.length
    ) {
      if (block.shell && !isValidBash(block.source.join("\n"))) {
        return "invalid bash syntax";
      }
      block = undefined;
      continue;
    }

    if (block.shell) {
      let offset = 0;
      while (
        offset < block.indentation &&
        line[offset] === " "
      ) {
        offset += 1;
      }
      block.source.push(line.slice(offset));
    }
  }
  return block?.shell === true ? "unclosed bash fence" : null;
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
  return /\b(?:not|(?:do|does|did|is|are|was|were|can|could|should|would|will|has|have|had)n't)\s+(?!(?:only|just|merely)\b)(?:(?!but\b|however\b|although\b|yet\b)[\p{L}\p{N}-]+\s+){0,4}$/iu.test(
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
