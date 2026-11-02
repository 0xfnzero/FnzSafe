const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const uiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(uiRoot, "..", "..");
const page = fs.readFileSync(
  path.join(uiRoot, "src", "app", "[locale]", "page.tsx"),
  "utf8",
);
const openExternal = fs.readFileSync(
  path.join(uiRoot, "src", "lib", "openExternal.ts"),
  "utf8",
);
const backend = fs.readFileSync(
  path.join(repoRoot, "crates", "desktop-api", "src", "main.rs"),
  "utf8",
);
const tauriLib = fs.readFileSync(
  path.join(uiRoot, "src-tauri", "src", "lib.rs"),
  "utf8",
);
const capabilities = fs.readFileSync(
  path.join(uiRoot, "src-tauri", "capabilities", "default.json"),
  "utf8",
);

assert.match(page, /const SOLANA_FAUCET_URL = "https:\/\/faucet\.solana\.com\/";/);
assert.match(page, /const CIRCLE_FAUCET_URL = "https:\/\/faucet\.circle\.com\/";/);
assert.match(page, /const openWalletFaucet = async/);
assert.match(page, /const faucetUrl = faucet === "circle" \? CIRCLE_FAUCET_URL : SOLANA_FAUCET_URL/);
assert.match(page, /await openExternalUrl\(faucetUrl\)/);
assert.match(page, /from "@\/lib\/openExternal"/);
assert.match(
  page,
  /\(effectiveNetwork === "devnet" \|\| effectiveNetwork === "testnet"\)/,
);
assert.match(page, /data-wallet-faucet-menu/);
assert.match(page, /role="menu"/);
assert.match(page, /role="menuitem"/);
assert.match(page, /void openWalletFaucet\(effectiveWallet, "solana"\)/);
assert.match(page, /void openWalletFaucet\(effectiveWallet, "circle"\)/);
assert.doesNotMatch(page, /window\.open\(SOLANA_FAUCET_URL/);
assert.doesNotMatch(page, /apiFetch\("wallet\/airdrop"/);

assert.match(openExternal, /openValidatedExternalUrl\(url, "open_external_url"\)/);
assert.match(openExternal, /await invoke\(command, \{\s*url: target\s*\}\)/);
assert.match(openExternal, /__TAURI_INTERNALS__/);
assert.match(openExternal, /window\.open\(target, "_blank", "noopener,noreferrer"\)/);

assert.match(tauriLib, /fn open_external_url\(url: String\)/);
assert.match(tauriLib, /fn spawn_system_browser\(url: &str\)/);
assert.match(tauriLib, /Command::new\("open"\)/);
assert.match(tauriLib, /generate_handler!\[[\s\S]*proxy_api_request[\s\S]*open_external_url[\s\S]*\]/);
assert.match(capabilities, /allow-open-external-url/);

assert.doesNotMatch(backend, /\/api\/wallet\/airdrop/);
assert.doesNotMatch(backend, /request_airdrop\(/);
assert.match(backend, /"features": \[.*"faucet".*\]/);

const translationKeys = [
  "faucetMenu",
  "faucetMenuTooltip",
  "faucetMenuHelpAriaLabel",
  "faucetAirdrop",
  "faucetAirdropTooltip",
  "faucetAirdropHelpAriaLabel",
  "faucetAirdropOpened",
  "faucetAirdropFailed",
  "circleFaucet",
  "circleFaucetTooltip",
  "circleFaucetHelpAriaLabel",
  "circleFaucetOpened",
  "circleFaucetFailed",
];
for (const locale of ["en", "zh"]) {
  const messages = JSON.parse(
    fs.readFileSync(path.join(uiRoot, "src", "messages", `${locale}.json`), "utf8"),
  );
  const walletMessages = messages.features?.["wallet-list"];
  for (const key of translationKeys) {
    assert.equal(typeof walletMessages?.[key], "string", `${locale}.${key} is required`);
    assert.ok(walletMessages[key].trim().length > 0, `${locale}.${key} must not be empty`);
  }
  assert.match(
    walletMessages.faucetAirdropTooltip,
    /faucet\.solana\.com/,
    `${locale}.faucetAirdropTooltip must mention faucet.solana.com`,
  );
  assert.match(
    walletMessages.circleFaucetTooltip,
    /faucet\.circle\.com/,
    `${locale}.circleFaucetTooltip must mention faucet.circle.com`,
  );
}

console.log("Official faucet external-browser contract checks passed.");
