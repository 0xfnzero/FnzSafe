const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pattern = "a{b,c}d";
const expected = ["abd", "acd"];
const numericPattern = "item-{1..3}";
const numericExpected = ["item-1", "item-2", "item-3"];

async function main() {
  const braceExpansion = require("brace-expansion");
  assert.equal(require("brace-expansion/package.json").version, require("../vendor/brace-expansion-compat/package.json").version);
  assert.equal(require("brace-expansion-upstream/package.json").version, require("../package.json").devDependencies["brace-expansion-upstream"].split("@").at(-1));
  assert.equal(typeof braceExpansion, "function");
  assert.equal(typeof braceExpansion.expand, "function");
  assert.equal(braceExpansion.EXPANSION_MAX, 100_000);
  assert.equal(braceExpansion.EXPANSION_MAX_LENGTH, 4_000_000);
  assert.deepEqual(braceExpansion(pattern), expected);
  assert.deepEqual(braceExpansion.expand(pattern), expected);
  assert.deepEqual(braceExpansion(numericPattern), numericExpected);

  const importedBraceExpansion = await import("brace-expansion");
  assert.equal(typeof importedBraceExpansion.default, "function");
  assert.equal(typeof importedBraceExpansion.expand, "function");
  assert.equal(importedBraceExpansion.EXPANSION_MAX, 100_000);
  assert.equal(importedBraceExpansion.EXPANSION_MAX_LENGTH, 4_000_000);
  assert.deepEqual(importedBraceExpansion.expand(pattern), expected);
  assert.deepEqual(importedBraceExpansion.default(numericPattern), numericExpected);

  const legacyMinimatch = require("minimatch");
  assert.equal(require("minimatch/package.json").version, "3.1.5");
  assert.equal(typeof legacyMinimatch, "function");
  assert.deepEqual(legacyMinimatch.braceExpand(pattern), expected);
  assert.deepEqual(legacyMinimatch.braceExpand(numericPattern), numericExpected);
  assert.equal(legacyMinimatch("abd", pattern), true);
  assert.equal(legacyMinimatch("item-2", numericPattern), true);
  assert.equal(legacyMinimatch("aed", pattern), false);

  const typescriptEstreeRequire = createRequire(
    require.resolve("@typescript-eslint/typescript-estree"),
  );
  const modernMinimatch = typescriptEstreeRequire("minimatch");
  const modernMinimatchPackagePath = typescriptEstreeRequire.resolve(
    "minimatch/package.json",
  );
  assert.equal(typescriptEstreeRequire(modernMinimatchPackagePath).version, "11.0.1");
  assert.equal(typeof modernMinimatch.minimatch, "function");
  assert.deepEqual(modernMinimatch.braceExpand(pattern), expected);
  assert.deepEqual(modernMinimatch.braceExpand(numericPattern), numericExpected);
  assert.equal(modernMinimatch.minimatch("acd", pattern), true);
  assert.equal(modernMinimatch.minimatch("item-3", numericPattern), true);
  assert.equal(modernMinimatch.minimatch("aed", pattern), false);

  const modernMinimatchEsm = await import(
    pathToFileURL(
      path.join(path.dirname(modernMinimatchPackagePath), "dist/esm/index.js"),
    ).href
  );
  assert.deepEqual(modernMinimatchEsm.braceExpand(pattern), expected);
  assert.deepEqual(
    modernMinimatchEsm.braceExpand(numericPattern),
    numericExpected,
  );
  assert.equal(modernMinimatchEsm.minimatch("abd", pattern), true);
  assert.equal(modernMinimatchEsm.minimatch("item-1", numericPattern), true);
  assert.equal(modernMinimatchEsm.minimatch("aed", pattern), false);

  console.log("dependency compatibility checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
