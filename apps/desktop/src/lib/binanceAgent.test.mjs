import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./binanceAgent.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const agent = await import(moduleUrl);

test("Binance Agent defaults to testnet with trading disabled", () => {
  assert.deepEqual(agent.readBinanceAgentPreferences({ getItem: () => null }), {
    environment: "testnet",
    tradingEnabled: false,
    maxOrderQuote: 100,
  });
});

test("Binance Agent preferences reject unsafe values and clamp limits", () => {
  assert.deepEqual(agent.normalizeBinanceAgentPreferences({
    environment: "other",
    tradingEnabled: "yes",
    maxOrderQuote: 2_000_000,
  }), {
    environment: "testnet",
    tradingEnabled: false,
    maxOrderQuote: 1_000_000,
  });
  assert.equal(agent.normalizeBinanceAgentPreferences({ environment: "production", tradingEnabled: true, maxOrderQuote: 0 }).maxOrderQuote, 1);
});

test("Binance Agent preferences recover from corrupt storage", () => {
  assert.deepEqual(agent.readBinanceAgentPreferences({ getItem: () => "{" }), agent.DEFAULT_BINANCE_AGENT_PREFERENCES);
});
