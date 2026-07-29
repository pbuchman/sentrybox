import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const rootRequire = createRequire(import.meta.url);
const nodeGypPackagePath = rootRequire.resolve("node-gyp/package.json");
const nodeGypRequire = createRequire(nodeGypPackagePath);

test("the repository Node range is supported by node-gyp", async () => {
  const repositoryPackage = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const nodeGypPackage = nodeGypRequire("node-gyp/package.json");
  const semver = nodeGypRequire("semver");

  assert.equal(
    semver.subset(repositoryPackage.engines.node, nodeGypPackage.engines.node),
    true,
    `${repositoryPackage.engines.node} must be a subset of node-gyp ${nodeGypPackage.version}'s ${nodeGypPackage.engines.node}`,
  );
});
