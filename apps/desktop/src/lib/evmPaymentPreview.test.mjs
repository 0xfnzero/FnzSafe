import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./evmPaymentPreview.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { isMatchingEvmPaymentPreview } = await import(moduleUrl);

const expected = {
  chainId: 1,
  walletAddress: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  amountAtomic: "123000000000000000",
  tokenContract: null,
};

const preview = (overrides = {}) => ({
  preview_id: "preview-identifier-123456",
  chain: { chain_id: 1 },
  wallet_address: expected.walletAddress,
  recipient: expected.recipient,
  token_contract: null,
  amount_wei_or_units: expected.amountAtomic,
  gas_limit: "21000",
  gas_price_wei: "1000000000",
  max_fee_per_gas_wei: "1200000000",
  max_priority_fee_per_gas_wei: "100000000",
  fee_model: "eip1559",
  nonce: "4",
  estimated_fee_wei: "25200000000000",
  warnings: [],
  ...overrides,
});

test("accepts a preview that exactly matches the requested payment", () => {
  assert.equal(isMatchingEvmPaymentPreview(preview(), expected), true);
});

test("rejects security-sensitive preview field substitutions", () => {
  assert.equal(isMatchingEvmPaymentPreview(preview({ recipient: "0x3333333333333333333333333333333333333333" }), expected), false);
  assert.equal(isMatchingEvmPaymentPreview(preview({ amount_wei_or_units: "1" }), expected), false);
  assert.equal(isMatchingEvmPaymentPreview(preview({ chain: { chain_id: 10 } }), expected), false);
  assert.equal(isMatchingEvmPaymentPreview(preview({ token_contract: expected.recipient }), expected), false);
  assert.equal(isMatchingEvmPaymentPreview(preview({ gas_limit: "2.1e4" }), expected), false);
});

test("compares EVM addresses case-insensitively", () => {
  assert.equal(isMatchingEvmPaymentPreview(preview({
    wallet_address: expected.walletAddress.toUpperCase(),
    recipient: expected.recipient.toUpperCase(),
  }), expected), true);
});
