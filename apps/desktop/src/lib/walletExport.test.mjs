import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./walletExport.ts", import.meta.url), "utf8");
const walletPageSource = fs.readFileSync(new URL("../app/[locale]/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const walletExport = await import(moduleUrl);

const context = {
  family: "bitcoin",
  chainId: "bip122:000000000019d6689c085ae165831e93",
  expectedAddress: "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
};
const validResponse = {
  export_protocol_version: 1,
  family: "bitcoin",
  address: context.expectedAddress,
  encoding: "wif-compressed",
  derivation_path: "m/86'/0'/0'/0/0",
  private_key: "KyZpNDKnfs94yt9cfUii5oW6wLvDaPrEPy6cRDqFrLrBQCWZ2TUw",
};

test("does not make an export value renderable before explicit reveal", () => {
  const secret = "test-secret-that-must-not-enter-the-dom";
  assert.equal(walletExport.renderableSensitiveExportValue(secret, false), null);
  assert.equal(walletExport.renderableSensitiveExportValue(secret, true), secret);
});

test("wallet export UI never interpolates the raw secret into hidden plaintext views", () => {
  assert.equal(walletPageSource.includes("{sensitiveExport.value}"), false);
  assert.equal(
    walletPageSource.includes("splitSensitiveExportIntoSegments(sensitiveExport.value"),
    false,
  );
  assert.match(walletPageSource, /!sensitivePlaintextRevealed\s*\?/);
});

test("accepts a mainnet compressed Bitcoin WIF response", () => {
  const result = walletExport.validatePrivateKeyExport(validResponse, context);
  assert.equal(result.ok, true);
  assert.equal(result.value.privateKey, validResponse.private_key);
});

test("accepts a BIP84 child-key WIF only for a Native SegWit account", () => {
  const nativeSegwitContext = {
    ...context,
    expectedAddress: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    derivationPath: "m/84'/0'/0'/0/0",
  };
  const result = walletExport.validatePrivateKeyExport({
    ...validResponse,
    address: nativeSegwitContext.expectedAddress,
    derivation_path: nativeSegwitContext.derivationPath,
    encoding: "wif-compressed",
  }, nativeSegwitContext);

  assert.equal(result.ok, true);
});

test("accepts the standard compressed WIF for a BIP84 account", () => {
  const result = walletExport.validatePrivateKeyExport({
    ...validResponse,
    address: "bc1qexample",
    encoding: "wif-compressed",
    derivation_path: "m/84'/0'/0'/0/0",
  }, {
    ...context,
    expectedAddress: "bc1qexample",
    derivationPath: "m/84'/0'/0'/0/0",
  });
  assert.equal(result.ok, true);
});

test("rejects a stale backend response before exposing a Solana key", () => {
  const result = walletExport.validatePrivateKeyExport({
    private_key: "4".repeat(88),
    public_key: context.expectedAddress,
  }, context);
  assert.deepEqual(result, { ok: false, error: "incompatible-backend" });
});

test("rejects malformed or wrong-network Bitcoin private keys", () => {
  assert.deepEqual(
    walletExport.validatePrivateKeyExport({ ...validResponse, private_key: "4".repeat(88) }, context),
    { ok: false, error: "invalid-private-key" },
  );
  assert.deepEqual(
    walletExport.validatePrivateKeyExport({ ...validResponse, private_key: `c${"1".repeat(51)}` }, context),
    { ok: false, error: "invalid-private-key" },
  );
});

test("rejects an export derived for a different visible account", () => {
  const result = walletExport.validatePrivateKeyExport(
    { ...validResponse, address: "bc1qdifferent" },
    context,
  );
  assert.deepEqual(result, { ok: false, error: "account-mismatch" });
});

test("rejects an export from a different Bitcoin address type", () => {
  const result = walletExport.validatePrivateKeyExport(validResponse, {
    ...context,
    derivationPath: "m/84'/0'/0'/0/0",
  });
  assert.deepEqual(result, { ok: false, error: "account-mismatch" });
});

test("mnemonic exports require the same version, family, and visible account", () => {
  const response = {
    export_protocol_version: 1,
    family: "bitcoin",
    address: context.expectedAddress,
    derivation_path: "m/86'/0'/0'/0/0",
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  };
  assert.equal(walletExport.validateMnemonicExport(response, context).ok, true);
  assert.deepEqual(
    walletExport.validateMnemonicExport({ ...response, export_protocol_version: undefined }, context),
    { ok: false, error: "incompatible-backend" },
  );
  assert.deepEqual(
    walletExport.validateMnemonicExport({ ...response, family: "solana" }, context),
    { ok: false, error: "incompatible-backend" },
  );
});
