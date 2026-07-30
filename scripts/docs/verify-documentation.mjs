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

const APPROVED_NEGATED_CLAIM_CONTEXTS = [
  /\b(?:is|are|was|were)\s+not\s+intended\s+by\s+(?:its|their|the)\s+maintainers\s+to\s+be\s+(?:a|an)\s+$/iu,
  /\b(?:not|(?:do|does|did|is|are|was|were|can|could|should|would|will|has|have|had)n't)\s+(?!(?:only|just|merely)\b)(?:(?!but\b|however\b|although\b|yet\b)[\p{L}\p{N}-]+\s+){0,4}$/iu,
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
  const documents = new Map();

  async function documentation(path) {
    let document = documents.get(path);
    if (document === undefined) {
      const source = await readFile(path, "utf8");
      const structuralContent = maskFencedCodeAndHtmlComments(source);
      document = {
        source,
        linkContent: maskInlineCode(structuralContent),
        headingAnchors: markdownHeadingAnchors(structuralContent),
      };
      documents.set(path, document);
    }
    return document;
  }

  for (const file of markdownFiles) {
    const path = resolve(root, file);
    const displayPath = relative(root, path);
    const { source, linkContent } = await documentation(path);

    for (const target of markdownLinkTargets(linkContent)) {
      if (isIgnoredLink(target)) continue;
      const localTarget = parseLocalLinkTarget(target);
      const targetPath =
        localTarget.path.length === 0
          ? path
          : resolve(dirname(path), localTarget.path);
      if (!(await fileExists(targetPath))) {
        diagnostics.push(
          `${displayPath}: missing local link target: ${target}`,
        );
        continue;
      }
      if (
        localTarget.fragment !== null &&
        localTarget.fragment.length > 0 &&
        (localTarget.path.length === 0 || /\.md$/iu.test(targetPath)) &&
        !(await documentation(targetPath)).headingAnchors.has(
          localTarget.fragment,
        )
      ) {
        diagnostics.push(
          `${displayPath}: missing local link fragment: ${target}`,
        );
      }
    }

    if (!isArchivedDocumentation(displayPath)) {
      const bashDiagnostic = bashFenceDiagnostic(source);
      if (bashDiagnostic !== null) {
        diagnostics.push(`${displayPath}: ${bashDiagnostic}`);
      }

      for (const [category, expression] of FORBIDDEN_CLAIMS) {
        if (hasUnqualifiedClaim(linkContent, expression)) {
          diagnostics.push(`${displayPath}: forbidden claim: ${category}`);
        }
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
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target);
}

function parseLocalLinkTarget(target) {
  const hashIndex = target.indexOf("#");
  const queryIndex = target.indexOf("?");
  const pathEnd = Math.min(
    hashIndex === -1 ? target.length : hashIndex,
    queryIndex === -1 ? target.length : queryIndex,
  );
  return {
    path: decodeLinkPart(target.slice(0, pathEnd)),
    fragment:
      hashIndex === -1 ? null : decodeLinkPart(target.slice(hashIndex + 1)),
  };
}

function decodeLinkPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isArchivedDocumentation(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("docs/archive/");
}

function maskFencedCodeAndHtmlComments(content) {
  const characters = content.split("");
  let fence;
  let offset = 0;

  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const end = newline === -1 ? content.length : newline + 1;
    const line = content
      .slice(offset, newline === -1 ? content.length : newline)
      .replace(/\r$/u, "");

    if (fence === undefined) {
      const opening = /^(?: {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
      if (opening !== null) {
        fence = { character: opening[1][0], length: opening[1].length };
        maskRange(characters, offset, end);
      }
    } else {
      maskRange(characters, offset, end);
      const closing = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(line);
      if (
        closing !== null &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) {
        fence = undefined;
      }
    }

    offset = end;
  }

  let masked = characters.join("");
  for (const match of masked.matchAll(/<!--[\s\S]*?(?:-->|$)/gu)) {
    maskRange(characters, match.index, match.index + match[0].length);
  }
  masked = characters.join("");
  return masked;
}

function maskInlineCode(content) {
  const characters = content.split("");
  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] !== "`" || isEscaped(content, cursor)) {
      cursor += 1;
      continue;
    }

    const openingLength = backtickRunLength(content, cursor);
    let closing = cursor + openingLength;
    while (closing < content.length) {
      if (content[closing] !== "`") {
        closing += 1;
        continue;
      }
      const closingLength = backtickRunLength(content, closing);
      if (closingLength === openingLength) break;
      closing += closingLength;
    }
    if (closing >= content.length) {
      cursor += openingLength;
      continue;
    }

    maskRange(characters, cursor, closing + openingLength);
    cursor = closing + openingLength;
  }
  return characters.join("");
}

function backtickRunLength(content, start) {
  let end = start;
  while (content[end] === "`") end += 1;
  return end - start;
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  }
}

function markdownHeadingAnchors(content) {
  const headings = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const atx = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/u.exec(line);
    if (atx !== null) {
      headings.push(atx[1].replace(/[ \t]+#+[ \t]*$/u, ""));
      continue;
    }
    if (
      line.trim().length > 0 &&
      index + 1 < lines.length &&
      /^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1])
    ) {
      headings.push(line.trim());
      index += 1;
    }
  }

  const anchors = new Set();
  for (const heading of headings) {
    const base = githubHeadingSlug(heading);
    let slug = base;
    let suffix = 0;
    while (anchors.has(slug)) {
      suffix += 1;
      slug = `${base}-${String(suffix)}`;
    }
    anchors.add(slug);
  }
  return anchors;
}

function githubHeadingSlug(heading) {
  const text = markdownInlineText(heading).toLowerCase().trim();
  return text
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, "")
    .replace(/\s/gu, "-");
}

function markdownInlineText(value) {
  return value
    .replace(/!\[([^\]\r\n]*)\]\([^\r\n)]*\)/gu, "$1")
    .replace(/\[([^\]\r\n]+)\]\([^\r\n)]*\)/gu, "$1")
    .replace(/!?\[([^\]\r\n]+)\]\[[^\]\r\n]*\]/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/(`+)(.*?)\1/gu, "$2")
    .replace(/(\*\*|__|~~)(.*?)\1/gu, "$2")
    .replace(/([*_])(.*?)\1/gu, "$2")
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, "$1")
    .replace(/&(?:amp|lt|gt|quot|apos);/giu, (entity) =>
      ({
        "&amp;": "&",
        "&apos;": "'",
        "&gt;": ">",
        "&lt;": "<",
        "&quot;": '"',
      })[entity.toLowerCase()],
    );
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
      content.lastIndexOf(":", index),
      content.lastIndexOf(",", index),
    ) + 1,
    index,
  );
  return APPROVED_NEGATED_CLAIM_CONTEXTS.some((expression) =>
    expression.test(context),
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
