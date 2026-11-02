# FnzSafe v0.6.0

## What's new

- Desktop Safe EVM multisig: a Safe 1.4.1 creation wizard, existing account import, transaction proposals, EOA signature collection and merging, fee previews, execution, and receipt checks.
- Typed ABI contract calls with nested tuples and arrays, Safe Transaction Builder 1.0 imports, and proposal signature exchange. Mainnet and testnet records are isolated.
- Wallet recovery from plaintext private keys, plaintext mnemonic phrases, and existing encrypted backups across EVM, Solana, and other implemented chain adapters. Bitcoin private-key recovery supports mainnet compressed WIF only.
- Binance Agent OS integrations, a Web3 skill marketplace, a connection center, and expanded trading and onchain workflows.
- Project-based EVM ABI read/write calls, deep-link handling after unlock, Solana wallet program discovery, and deployment rent reclamation.
- Fixed a DApp autofill deadlock caused by synchronously querying a webview URL on the CEF UI thread. Autofill now runs on a background worker and rechecks the page origin before filling credentials.
- Updated the desktop application and local API to 0.6.0 and fixed release-check compatibility.

## Download and installation

`FnzSafe_0.6.0_aarch64.dmg` is for macOS Apple Silicon (M-series chips). Open the DMG and drag FnzSafe into Applications. `SHA256SUMS` contains the installer's SHA-256 checksum.

The application uses an **ad-hoc signature, without an Apple Developer ID signature or Apple notarization**. Gatekeeper may block the first launch. After verifying the download source, allow it under System Settings → Privacy & Security. This release does not include installers for Intel Mac, Windows, Linux, or mobile platforms.

## Scope and validation

Safe support is limited to EOA owners, a threshold of at least two, and individual CALL transactions. Delegatecall, atomic batches, and contract-owner signatures are not supported. Compatible Safe 1.4.1 deployments are checked against the chain ID and deployed bytecode. Accounts and proposals are stored locally; export backups. See the [Safe multisig guide](https://github.com/0xfnzero/FnzSafe/blob/v0.6.0/docs/safe-multisig.md).

Release validation included frontend unit tests, type checking, lint, a static production build, Rust service tests (220 passed), desktop shell tests (119 passed), and formatting checks. ABI encoding was independently compared with ethers v6 in 1,273 cases. Real Safe lifecycle tests and 12 Solidity parameter-decoding cases ran on isolated Anvil instances. No user private keys were used and no test transactions were broadcast on public networks.

SDK crates retain their independent versions. No crates.io packages were published for this release.
