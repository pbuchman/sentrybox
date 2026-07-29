import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const rootRequire = createRequire(import.meta.url);

function loadEslintMinimatch() {
  const eslintRequire = createRequire(
    rootRequire.resolve("eslint/package.json"),
  );
  return eslintRequire("minimatch");
}

function loadTypescriptEslintMinimatch() {
  const typescriptEslintRequire = createRequire(
    rootRequire.resolve("typescript-eslint/package.json"),
  );
  const parserRequire = createRequire(
    typescriptEslintRequire.resolve("@typescript-eslint/parser/package.json"),
  );
  const typescriptEstreeRequire = createRequire(
    parserRequire.resolve("@typescript-eslint/typescript-estree/package.json"),
  );
  return typescriptEstreeRequire("minimatch").minimatch;
}

test("ESLint's minimatch v3 matches brace alternatives", () => {
  const minimatch = loadEslintMinimatch();

  assert.equal(minimatch("src/issue.ts", "src/{event,issue}.ts"), true);
  assert.equal(minimatch("src/project.ts", "src/{event,issue}.ts"), false);
});

test("typescript-eslint's minimatch v9 matches brace alternatives", () => {
  const minimatch = loadTypescriptEslintMinimatch();

  assert.equal(minimatch("src/issue.ts", "src/{event,issue}.ts"), true);
  assert.equal(minimatch("src/project.ts", "src/{event,issue}.ts"), false);
});
