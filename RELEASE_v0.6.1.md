# FnzSafe v0.6.1

## Changes

- Configure a custom RPC for the selected EVM network in Settings → Networks. The endpoint is verified against the selected chain ID before saving, and the configuration persists across restarts.
- Restore the built-in RPC without an online check. Custom endpoints do not silently fall back to public providers. Built-in endpoints retain their existing failover behavior.
- Hide RPC URLs by default, avoid displaying provider errors that could contain API keys, and invalidate old balance caches and transaction previews after an endpoint change.
- Update the Robinhood Chain block explorer to the endpoint listed by Etherscan (PR #7).
- Include the extension source fix that skips tokens with unknown decimals instead of displaying incorrectly scaled balances (PR #9). This release packages the desktop application only.

Custom RPCs serve chain queries and transaction submission. They do not replace an address indexer for automatic ERC-20 discovery; the extension's Robinhood Chain discovery issue (#8) remains open.

## Installation

Download `FnzSafe_0.6.1_aarch64.dmg` for macOS Apple Silicon and drag FnzSafe into Applications. Verify the download against `SHA256SUMS`.

The application is ad-hoc signed. It does not have an Apple Developer ID signature and is not notarized. After verifying the source, the first launch may require approval in System Settings → Privacy & Security.

## Validation

Frontend unit tests, TypeScript, lint, Rust service tests, and the production desktop build were checked. RPC regression tests cover matching and mismatched chain IDs and ensure custom endpoints do not fall back to public RPCs. No user keys or public-network transactions were used for validation.
