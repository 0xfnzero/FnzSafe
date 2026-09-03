import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./requestIntent.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const requests = await import(moduleUrl);

test("request generations reject stale A-B-A responses", () => {
  const intent = requests.createAsyncRequestIntent();
  const firstA = requests.beginAsyncRequestIntent(intent, "wallet-a");
  const b = requests.beginAsyncRequestIntent(intent, "wallet-b");
  const secondA = requests.beginAsyncRequestIntent(intent, "wallet-a");

  assert.equal(requests.isCurrentAsyncRequest(intent, "wallet-a", firstA), false);
  assert.equal(requests.isCurrentAsyncRequest(intent, "wallet-b", b), false);
  assert.equal(requests.isCurrentAsyncRequest(intent, "wallet-a", secondA), true);
});

test("parallel requests for the same intent share a generation", () => {
  const intent = requests.createAsyncRequestIntent();
  const first = requests.beginAsyncRequestIntent(intent, "wallet-a");
  const second = requests.beginAsyncRequestIntent(intent, "wallet-a");
  assert.equal(first, second);
});
