import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./evmAssetSend.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { resolveEvmAssetSendContext } = await import(moduleUrl);

const base = {
  unified_evm_send: 1,
  evm_asset_chain_id: 4663,
  evm_asset_decimals: 18,
  evm_asset_symbol: "ETH",
  evm_asset_chain: "Robinhood Chain",
  evm_asset_balance: "0.3363",
};

test("native transfers always discard stale contract state", () => {
  const context = resolveEvmAssetSendContext({
    ...base,
    evm_asset_kind: "native",
    evm_asset_contract: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(context.tokenContract, null);
  assert.equal(context.chainId, 4663);
});

test("ERC-20 transfers use the immutable asset contract", () => {
  const contract = "0x2222222222222222222222222222222222222222";
  const context = resolveEvmAssetSendContext({
    ...base,
    evm_asset_kind: "erc20",
    evm_asset_contract: contract,
  });
  assert.equal(context.tokenContract, contract);
});

test("rejects incomplete or malformed asset identity", () => {
  assert.throws(() => resolveEvmAssetSendContext({ ...base, evm_asset_kind: "native", evm_asset_chain_id: 0 }));
  assert.throws(() => resolveEvmAssetSendContext({ ...base, evm_asset_kind: "erc20", evm_asset_contract: "0x1234" }));
});

test("returns null for the advanced workbench flow", () => {
  assert.equal(resolveEvmAssetSendContext({}), null);
});
