import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FORBIDDEN_CLAIMS = [
  {
    category: "drop-in/full Sentry replacement",
    expression: /\b(?:drop-in|full)\s+sentry\s+replacement\b/giu,
    correctivePrefixes: [
      /\b(?:is|are)\s+not\s+(?:a\s+)?$/iu,
      /\b(?:offers?|provides?)\s+no\s+(?:a\s+)?$/iu,
      /\bwill\s+never\s+be\s+(?:a\s+)?$/iu,
      /\b(?:does|do)\s+not\s+(?:offer|provide|constitute)\s+(?:a\s+)?$/iu,
    ],
  },
  {
    category: "fully Sentry-compatible",
    expression: /\bfully\s+sentry-compatible\b/giu,
    correctivePrefixes: [/\b(?:is|are)\s+not\s+$/iu],
  },
  {
    category: "built-in/native MCP",
    expression: /\b(?:built-in|native)\s+MCP\b/giu,
    correctivePrefixes: [
      /\b(?:does|do)\s+not\s+(?:include|provide|offer)\s+$/iu,
      /\b(?:has|have)\s+no\s+$/iu,
    ],
  },
  {
    category: "same grouping as Sentry",
    expression: /\bsame\s+grouping\s+as\s+Sentry\b/giu,
    correctivePrefixes: [
      /\b(?:does|do)\s+not\s+(?:use|provide|claim)\s+(?:the\s+)?$/iu,
      /\b(?:is|are)\s+not\s+(?:the\s+)?$/iu,
    ],
  },
  {
    category: "guaranteed 30-day history",
    expression: /\bguaranteed\s+30-day\s+history\b/giu,
    correctivePrefixes: [
      /\b(?:does|do)\s+not\s+(?:offer|provide|promise)\s+$/iu,
      /\b(?:is|are)\s+not\s+$/iu,
    ],
  },
  {
    category: "hard 5 GiB total limit",
    expression: /\b5\s+GiB\s+total\s+limit\b/giu,
    correctivePrefixes: [
      /\b(?:does|do)\s+not\s+(?:impose|enforce|have)\s+(?:a\s+)?$/iu,
      /\b(?:is|are)\s+not\s+(?:a\s+)?$/iu,
    ],
  },
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

    const prose = maskNonProse(content);
    for (const link of markdownLinks(prose)) {
      if (link.undefinedReference !== undefined) {
        diagnostics.push(
          `${displayPath}: undefined Markdown reference: ${link.undefinedReference}`,
        );
        continue;
      }
      const target = link.target;
      if (isExternalLink(target)) continue;
      const { targetPath, fragment } = splitLocalTarget(target);
      const resolvedTarget =
        targetPath.length === 0
          ? path
          : resolveLocalTarget(root, dirname(path), targetPath);
      if (resolvedTarget === null || !(await fileExists(resolvedTarget))) {
        diagnostics.push(
          `${displayPath}: missing local link target: ${target}`,
        );
        continue;
      }
      if (
        fragment !== null &&
        !(await markdownFileContainsFragment(resolvedTarget, fragment))
      ) {
        diagnostics.push(
          `${displayPath}: missing local link fragment: ${target}`,
        );
      }
    }

    const bashDiagnostic = bashFenceDiagnostic(content);
    if (bashDiagnostic !== null) {
      diagnostics.push(`${displayPath}: ${bashDiagnostic}`);
    }

    for (const claim of FORBIDDEN_CLAIMS) {
      if (hasForbiddenClaim(prose, claim)) {
        diagnostics.push(`${displayPath}: forbidden claim: ${claim.category}`);
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

function markdownLinks(content) {
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
    if (match[2] === undefined && /^[ x]$/iu.test(match[1])) continue;
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
    if (target !== undefined) {
      targets.push({ index: match.index, target });
    } else {
      targets.push({
        index: match.index,
        target: "",
        undefinedReference: label,
      });
    }
  }

  return targets
    .sort((left, right) => left.index - right.index)
    .map(({ target, undefinedReference }) => ({ target, undefinedReference }));
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

function isExternalLink(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target);
}

function splitLocalTarget(target) {
  const hash = target.indexOf("#");
  const beforeFragment = hash === -1 ? target : target.slice(0, hash);
  const fragmentValue = hash === -1 ? null : target.slice(hash + 1);
  const query = beforeFragment.indexOf("?");
  return {
    targetPath:
      query === -1 ? beforeFragment : beforeFragment.slice(0, query),
    fragment:
      fragmentValue === null || fragmentValue.length === 0
        ? null
        : decodeURIComponentSafe(fragmentValue),
  };
}

function resolveLocalTarget(root, sourceDirectory, targetPath) {
  const decoded = decodeURIComponentSafe(targetPath);
  const target = decoded.startsWith("/")
    ? resolve(root, `.${decoded}`)
    : resolve(sourceDirectory, decoded);
  return target === root || target.startsWith(`${root}/`) ? target : null;
}

async function markdownFileContainsFragment(path, fragment) {
  if (!path.toLowerCase().endsWith(".md")) return false;
  const content = await readFile(path, "utf8");
  return markdownHeadingFragments(maskBlockContent(content)).has(fragment);
}

function markdownHeadingFragments(content) {
  const fragments = new Set();
  const occurrences = new Map();
  for (const match of content.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/gmu)) {
    const base = githubHeadingSlug(match[1]);
    if (base.length === 0) continue;
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    fragments.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return fragments;
}

function githubHeadingSlug(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/\s/gu, "-");
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function maskNonProse(content) {
  const characters = maskBlockContent(content).split("");
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
      }
    }
  };
  const withoutBlocks = characters.join("");
  for (const match of withoutBlocks.matchAll(/(`+)(?!`)([^\r\n]*?)\1/gu)) {
    mask(match.index, match.index + match[0].length);
  }
  return characters.join("");
}

function maskBlockContent(content) {
  const characters = content.split("");
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
      }
    }
  };
  for (const match of content.matchAll(/<!--[\s\S]*?-->/gu)) {
    mask(match.index, match.index + match[0].length);
  }

  let block;
  let offset = 0;
  for (const rawLine of content.split(/(?<=\n)/u)) {
    const line = rawLine.replace(/\r?\n$/u, "");
    if (block === undefined) {
      const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
      if (opening !== null) {
        block = {
          start: offset,
          character: opening[2][0],
          length: opening[2].length,
        };
      }
    } else {
      const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(line);
      if (
        closing !== null &&
        closing[2][0] === block.character &&
        closing[2].length >= block.length
      ) {
        mask(block.start, offset + rawLine.length);
        block = undefined;
      }
    }
    offset += rawLine.length;
  }
  if (block !== undefined) mask(block.start, content.length);
  return characters.join("");
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

function hasForbiddenClaim(content, claim) {
  for (const match of content.matchAll(claim.expression)) {
    const context = sentencePrefix(content, match.index);
    if (
      !claim.correctivePrefixes.some((expression) => expression.test(context))
    ) {
      return true;
    }
  }
  return false;
}

function sentencePrefix(content, index) {
  return content.slice(
    Math.max(
      content.lastIndexOf(".", index),
      content.lastIndexOf("!", index),
      content.lastIndexOf("?", index),
      content.lastIndexOf(";", index),
    ) + 1,
    index,
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
