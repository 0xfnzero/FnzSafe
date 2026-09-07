import test from "node:test";
import assert from "node:assert/strict";
import { signalTranslationTarget } from "./signalTranslation.ts";

test("offers Chinese translation for English signal content", () => {
  assert.equal(signalTranslationTarget("This token has strong momentum.", "zh"), "zh-CN");
});

test("offers English translation for Chinese signal content", () => {
  assert.equal(signalTranslationTarget("这个代币正在快速上涨。", "en"), "en");
});

test("does not translate content already matching the interface language", () => {
  assert.equal(signalTranslationTarget("这个代币正在快速上涨。", "zh"), undefined);
  assert.equal(signalTranslationTarget("This token has strong momentum.", "en"), undefined);
});

test("ignores contracts, handles, and cashtags when detecting language", () => {
  assert.equal(signalTranslationTarget("$MUSD @trader 0xc255d8b48efbce2cb821a28517678ae685587777", "zh"), undefined);
});
