import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./researchAiProviders.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const providers = await import(moduleUrl);

test("provider presets are unique and use secure or local endpoints", () => {
  const kinds = providers.RESEARCH_AI_PROVIDER_PRESETS.map((preset) => preset.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.equal(providers.isResearchAiProviderKind("deepseek"), true);
  assert.equal(providers.isResearchAiProviderKind("claude"), false);
  for (const preset of providers.RESEARCH_AI_PROVIDER_PRESETS) {
    if (!preset.endpoint) continue;
    const url = new URL(preset.endpoint);
    assert.equal(url.protocol === "https:" || url.hostname === "127.0.0.1", true);
  }
});

test("preset lookup returns the exact provider configuration", () => {
  assert.equal(providers.researchAiProviderPreset("grok").label, "Grok / xAI");
  assert.equal(providers.researchAiProviderPreset("ollama").requiresApiKey, false);
});
