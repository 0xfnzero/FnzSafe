# FnzSafe Shared Contracts

This package holds cross-surface contracts for the desktop API, mobile bridge,
and UI clients.

Mobile v1 includes wallet management, assets, transfers, 2FA, PumpFun/PumpSwap,
dApp signing, and Squads multisig. It intentionally excludes Program deploy,
Program upgrade, source builds, and generic Program invocation.

## Website FnzSafe Deep Links

Use `fnzsafe-deep-link.ts` in the official website or any partner dApp that
wants to prefer FnzSafe while still allowing Phantom, Solflare, Backpack, and
other wallets.

Recommended website flow:

1. Render the normal wallet list, sorted with `prioritizeFnzSafeWallets`.
2. If the user chooses FnzSafe, build a `fnzsafe://sign?...` URL with
   `buildFnzSafeSignDeepLink`.
3. Call `openFnzSafeDeepLinkWithFallback`.
4. If the browser stays visible, show the normal wallet picker or install
   guidance instead of blocking other wallets.

Browsers do not expose a reliable API for checking whether a custom desktop
protocol is installed. The helper uses the standard best-effort pattern:
attempt to open the protocol, then run the fallback only if the page remains
visible.
