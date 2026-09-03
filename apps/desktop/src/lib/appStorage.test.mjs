import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./appStorage.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const storage = await import(moduleUrl);

test("all supported themes survive the first-paint storage mirror", () => {
  assert.equal(storage.currentUiTheme("light"), "light");
  assert.equal(storage.currentUiTheme("dark"), "dark");
  assert.equal(storage.currentUiTheme("deep-sea"), "deep-sea");
  assert.equal(storage.currentUiTheme("unsupported"), "deep-sea");
});

test("persisted RPC profiles keep built-ins and reject malformed custom entries", () => {
  const profiles = storage.parsePersistedRpcProfiles([
    { id: "custom", name: "Custom", url: "https://rpc.example.com", network: "devnet" },
    { id: "bad", name: "Bad", url: "javascript:alert(1)", network: "mainnet" },
  ]);
  assert.ok(profiles.some((profile) => profile.id === "solana-mainnet"));
  assert.ok(profiles.some((profile) => profile.id === "custom"));
  assert.equal(profiles.some((profile) => profile.id === "bad"), false);
  assert.equal(storage.parsePersistedRpcProfiles({}), null);
});

test("persisted download history is validated and bounded", () => {
  const valid = {
    id: "download-1",
    filename: "diagnostics.json",
    path: "/tmp/diagnostics.json",
    createdAt: 1,
    type: "application/json",
  };
  assert.deepEqual(storage.parseDownloadHistory([valid, { ...valid, id: "bad", path: "relative" }]), [valid]);
  assert.equal(storage.parseDownloadHistory("invalid"), null);
});

test("custom EVM networks share strict URL and length normalization", () => {
  const valid = storage.normalizeStoredEvmChain({
    chain_id: 10,
    name: "Optimism",
    native_symbol: "ETH",
    rpc_url: "https://rpc.example.com/",
    explorer_url: "https://explorer.example.com/",
    testnet: false,
  });
  assert.equal(valid.rpc_url, "https://rpc.example.com");
  assert.equal(storage.normalizeStoredEvmChain({ ...valid, rpc_url: "http://" }), null);
  assert.equal(storage.normalizeStoredEvmChain({ ...valid, rpc_url: "https://user:pass@rpc.example.com" }), null);
  assert.equal(storage.normalizeStoredEvmChain({ ...valid, native_symbol: "X".repeat(17) }), null);
});
