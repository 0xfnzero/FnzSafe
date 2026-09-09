import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./chainMetadata.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const metadata = await import(moduleUrl);

test("built-in mainnets have locally bundled chain logos", () => {
  const builtInMainnetIds = [1, 10, 56, 137, 250, 324, 4663, 8453, 42161, 43114, 59144, 534352];
  for (const chainId of builtInMainnetIds) {
    const logoUri = metadata.chainLogoUri(chainId);
    assert.match(logoUri, /^\/chain-icons\/[a-z0-9-]+\.svg$/);
    assert.equal(fs.existsSync(new URL(`../../public${logoUri}`, import.meta.url)), true, `missing ${logoUri}`);
  }
  assert.equal(fs.existsSync(new URL(`../../public${metadata.SOLANA_CHAIN_LOGO_URI}`, import.meta.url)), true);
  assert.equal(fs.existsSync(new URL(`../../public${metadata.BITCOIN_CHAIN_LOGO_URI}`, import.meta.url)), true);
  assert.equal(fs.existsSync(new URL(`../../public${metadata.TRON_CHAIN_LOGO_URI}`, import.meta.url)), true);
});

test("custom networks keep the glyph fallback", () => {
  assert.equal(metadata.chainLogoUri(987654321), undefined);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "evm", chain_id: "eip155:987654321" }), undefined);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "cosmos", chain_id: "cosmos:cosmoshub-4" }), undefined);
});

test("chain descriptors resolve family and EVM network logos", () => {
  assert.equal(metadata.chainFamilyLogoUri("evm"), "/chain-icons/ethereum.svg");
  assert.equal(metadata.chainDescriptorLogoUri({ family: "evm", chain_id: "eip155:8453" }), "/chain-icons/base.svg");
  assert.equal(metadata.chainDescriptorLogoUri({ family: "solana", chain_id: "solana:mainnet" }), metadata.SOLANA_CHAIN_LOGO_URI);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "bitcoin", chain_id: "bip122:mainnet" }), metadata.BITCOIN_CHAIN_LOGO_URI);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "bitcoin", chain_id: "bip122:testnet" }), metadata.BITCOIN_CHAIN_LOGO_URI);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "tron", chain_id: "tron:728126428" }), metadata.TRON_CHAIN_LOGO_URI);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "tron", chain_id: "tron:2494104990" }), metadata.TRON_CHAIN_LOGO_URI);
});

test("malformed or mismatched chain identifiers do not receive a misleading logo", () => {
  assert.equal(metadata.chainDescriptorLogoUri({ family: "evm", chain_id: "eip155:8453:extra" }), undefined);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "evm", chain_id: "eip155:08453" }), undefined);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "evm", chain_id: "eip155:not-a-number" }), undefined);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "bitcoin", chain_id: "eip155:1" }), undefined);
  assert.equal(metadata.chainDescriptorLogoUri({ family: "tron", chain_id: "tron:" }), undefined);
});
