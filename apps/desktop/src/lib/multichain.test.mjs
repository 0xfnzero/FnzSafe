import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./multichain.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const multichain = await import(moduleUrl);

const chain = (overrides = {}) => ({
  chain_id: "eip155:1",
  family: "evm",
  name: "Ethereum",
  network: "mainnet",
  testnet: false,
  native_asset: { symbol: "ETH", name: "Ether", decimals: 18 },
  default_derivation_path: "m/44'/60'/0'/0/0",
  address_formats: ["eip55"],
  capabilities: ["accounts:derive", "accounts:validate", "assets:native_balance", "transactions:transfer"],
  endpoints: [],
  explorer_url: null,
  support_level: "stable",
  ...overrides,
});

test("capability tier distinguishes wallet operations from account-only adapters", () => {
  assert.equal(multichain.chainCapabilityTier(chain()), "wallet");
  assert.equal(multichain.chainCapabilityTier(chain({ family: "bitcoin", capabilities: ["accounts:derive", "accounts:validate"] })), "account");
  assert.equal(multichain.chainCapabilityTier(chain({ capabilities: ["accounts:validate"] })), "validation");
});

test("catalog parsing rejects malformed API payloads", () => {
  assert.deepEqual(multichain.parseChainCatalog([chain()]), [chain()]);
  assert.equal(multichain.parseChainCatalog({ chains: [chain()] }), null);
  assert.equal(multichain.parseChainCatalog([chain({ capabilities: null })]), null);
  assert.equal(multichain.parseChainCatalog([chain({ native_asset: { symbol: "BTC" } })]), null);
});

test("catalog filtering searches identity fields and keeps mainnets before testnets", () => {
  const chains = [
    chain({ chain_id: "bip122:test", family: "bitcoin", name: "Bitcoin Testnet", testnet: true }),
    chain({ chain_id: "bip122:main", family: "bitcoin", name: "Bitcoin", native_asset: { symbol: "BTC", name: "Bitcoin", decimals: 8 } }),
    chain(),
  ];
  assert.deepEqual(multichain.filterChainCatalog(chains, "bitcoin", "btc").map((item) => item.name), ["Bitcoin"]);
  assert.deepEqual(multichain.filterChainCatalog(chains, "bitcoin", "").map((item) => item.name), ["Bitcoin", "Bitcoin Testnet"]);
});

test("family counts remain open to future chain families", () => {
  const chains = [
    chain(),
    chain({ chain_id: "solana:mainnet", family: "solana" }),
    chain({ chain_id: "tron:mainnet", family: "tron" }),
    chain({ chain_id: "cosmos:hub", family: "cosmos" }),
  ];
  assert.deepEqual(multichain.chainFamilyCounts(chains), { evm: 1, solana: 1, tron: 1, cosmos: 1 });
  assert.deepEqual(multichain.visibleChainFamilies(chains), ["solana", "evm", "tron", "cosmos"]);
});

test("native amounts convert without floating point precision loss", () => {
  assert.equal(multichain.decimalToAtomicUnits("1.00000001", 8), "100000001");
  assert.equal(multichain.decimalToAtomicUnits("0.000001", 6), "1");
  assert.equal(multichain.decimalToAtomicUnits("21000000", 8), "2100000000000000");
  assert.equal(multichain.decimalToAtomicUnits("0.000000001", 8), null);
  assert.equal(multichain.decimalToAtomicUnits("1e-8", 8), null);
  assert.equal(multichain.atomicToDecimalUnits("100000001", 8), "1.00000001");
  assert.equal(multichain.atomicToDecimalUnits("1", 6), "0.000001");
  assert.equal(multichain.atomicToDecimalUnits("100000000000000000", 18), "0.1");
  assert.equal(multichain.atomicToDecimalUnits("0", 18), "0");
});
