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
});

test("custom networks keep the glyph fallback", () => {
  assert.equal(metadata.chainLogoUri(987654321), undefined);
});
