# FnzSafe Shared Contracts

This package holds cross-surface contracts for the desktop API, mobile bridge,
and UI clients.

Mobile v1 includes wallet management, assets, transfers, 2FA, PumpFun/PumpSwap,
dApp signing, and Squads multisig. It intentionally excludes Program deploy,
Program upgrade, source builds, and generic Program invocation.

## Generic FnzSafe Deep Links

Use `fnzsafe-deep-link.ts` in any website or dApp that wants to prefer FnzSafe
while still allowing Phantom, Solflare, Backpack, and other wallets. The deep
link protocol is generic: FnzSafe verifies the request origin, shows the site
name, URL, purpose, wallet, chain, and payload, then asks the user to approve or
reject. It does not assume a Fnzero-only user model.

Recommended website flow:

1. Render the normal wallet list, sorted with `prioritizeFnzSafeWallets`.
2. If the user chooses FnzSafe, build a `fnzsafe://sign?...` URL with
   `buildFnzSafeSignDeepLink`.
3. Call `openFnzSafeDeepLinkWithFallback`.
4. If the browser stays visible, show the normal wallet picker or install
   guidance instead of blocking other wallets.

For sign-in or wallet-binding flows, prefer `buildFnzSafeAuthMessage` instead
of hard-coding a product-specific message such as `fnzero wallet binding`.
Each site supplies its own domain, statement, nonce, URI, and callback URL.

Browsers do not expose a reliable API for checking whether a custom desktop
protocol is installed. The helper uses the standard best-effort pattern:
attempt to open the protocol, then run the fallback only if the page remains
visible.
