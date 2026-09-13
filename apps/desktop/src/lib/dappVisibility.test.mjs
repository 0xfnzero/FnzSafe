import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowNativeDappWebview } from "./dappVisibility.ts";

const visibleState = {
  workspaceVisible: true,
  connectRequestOpen: false,
  signRequestOpen: false,
  overlayOpen: false,
  webviewOpen: true,
  hasBounds: true,
};

test("native DApp webview hides while a wallet connection request is open", () => {
  assert.equal(shouldShowNativeDappWebview(visibleState), true);
  assert.equal(shouldShowNativeDappWebview({
    ...visibleState,
    connectRequestOpen: true,
  }), false);
});

test("native DApp webview remains hidden for signing prompts and browser overlays", () => {
  assert.equal(shouldShowNativeDappWebview({ ...visibleState, signRequestOpen: true }), false);
  assert.equal(shouldShowNativeDappWebview({ ...visibleState, overlayOpen: true }), false);
});
