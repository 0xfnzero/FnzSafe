import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./evmChainRules.ts", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../app/[locale]/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const merge = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "mergeEvmAssetSnapshotTokens");
assert.ok(merge);
const compiled = ts.transpileModule(`${source}\nexport ${merge.getText(ast)}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const rules = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const alias = "0x3600000000000000000000000000000000000000";

test("Arc fee display retains exact USDC precision without changing Ethereum", () => {
  for (const id of [5042, 5042002]) {
    assert.equal(rules.evmFeeLabel(id, "20000000000"), "0.00000002 USDC");
    assert.equal(rules.evmFeeLabel(id, "1000000000000000001"), "1.000000000000000001 USDC");
    assert.equal(rules.evmFeeLabel(id, "0"), "0 USDC");
    assert.equal(rules.evmFeeLabel(id, ""), "-");
    assert.equal(rules.isNativeTokenAlias(id, alias), true);
  }
  assert.equal(rules.evmFeeLabel(1, "20000000000"), "20000000000 wei");
  assert.equal(rules.isNativeTokenAlias(1, alias), false);
});

test("Arc asset merge removes old USDC aliases while preserving unrelated tokens and history", () => {
  const eurc = { contract_address: "0x1111111111111111111111111111111111111111", balance: "1" };
  for (const id of [5042, 5042002]) {
    const next = { chain: { chain_id: id }, wallet_address: "0xabc", tokens: [{ contract_address: alias }], history_status: "not_requested" };
    assert.equal(rules.mergeEvmAssetSnapshotTokens(null, next).tokens.length, 0);
    const previous = { ...next, tokens: [eurc, { contract_address: alias }], recent_transactions: [{ hash: "0x123" }], history_status: "unsupported" };
    const merged = rules.mergeEvmAssetSnapshotTokens(previous, next);
    assert.deepEqual(merged.tokens, [eurc]);
    assert.equal(merged.history_status, "unsupported");
    assert.deepEqual(merged.recent_transactions, previous.recent_transactions);
  }
});
