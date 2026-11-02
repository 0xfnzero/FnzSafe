# FnzSafe Chrome Extension 0.2.0

Manifest V3 wallet extension for EVM and Solana. Bitcoin and TRON support key recovery and address display; transaction signing and broadcasting for these families remain disabled.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Load `apps/extension/dist` as an unpacked extension from `chrome://extensions`.

## Appearance

Choose **Light**, **Dark** or **System** from the header or Settings → Appearance. The choice is stored locally and shared by the wallet and DApp confirmation windows. System follows the OS appearance. The refreshed interface includes an asset summary card, token icons, balance visibility control, transaction status badges, a receive-address sheet, and consistent multisig/settings forms.

## Recovery, networks and assets

- Restore a plaintext BIP-39 phrase or import an individual EVM/TRON hex key, Solana base58 key / seed hex / JSON key array, or Bitcoin mainnet compressed WIF / hex key. Bitcoin derives a native SegWit address.
- Restore extension encrypted backups, standard Web3 keystore v3, and supported FnzSafe desktop password-only key/mnemonic backups. Desktop custom derivation paths are preserved. Hardware-backed, social/MPC and other desktop backup schemes are not supported.
- Settings can append accounts to the existing encrypted vault and export an encrypted backup after password verification. Appending accounts preserves the original recovery phrase; keep the encrypted backup to recover separately imported keys.
- Configure HTTPS RPC endpoints per EVM network and Solana cluster, with chain ID / genesis verification. HTTP is allowed only for localhost testing. Reset restores the built-in endpoint. Custom endpoints do not silently fall back to another provider.
- Add ERC-20 contracts directly, read decimals and balances through the selected RPC, preview native/ERC-20 transfers, and check local submission receipts in Activity.
- Robinhood automatic token discovery remains unavailable (Issue #8). Custom RPC plus manual token import is a workaround, not a repair of the external indexer.

## Safe multisig

Create or open a verified Safe 1.4.1 account on the selected EVM network. Creation supports 2–50 EOA owners and a threshold of at least two. Proposals can send native assets or contain explicit contract calldata; export/import JSON to collect and merge owner signatures. Proposal hashes use the desktop-compatible format and are checked locally and on-chain. Execution requires the threshold and current nonce, simulates the transaction, and checks Safe execution events in its receipt.

Only verified canonical Safe deployments, EIP-712 EOA signatures and CALL operations with zero gas refunds are supported. Smart-contract owner signatures, delegate calls and a hosted transaction service are not supported. Raw contract calldata must be independently understood before signing.

## Installation

The 0.2.0 visual redesign is a release candidate awaiting browser acceptance testing. Build from source for now; the archive instructions below apply after publication.

Download and extract `FnzSafe-extension-0.2.0.zip` from the `extension-v0.2.0` GitHub Release. In Chrome, open `chrome://extensions`, enable Developer mode and choose **Load unpacked**, then select the extracted directory containing `manifest.json`. Keep that directory in place. This is an unpacked developer distribution, not a Chrome Web Store listing; updates are manual.

For local development, load `dist` after building. Use a separate Chrome profile and public test accounts for development; never fund fixture accounts on a public network.

## Reproducible validation

`npm test` covers RPC validation and redaction, plaintext recovery, encrypted backup formats, Safe signatures/proposals, vault migration, DApp permission/security boundaries and serialized background imports. The desktop compatibility fixtures were produced independently by the Rust implementation:

```bash
# Run from the repository root (requires the usual Rust/OpenSSL build dependencies).
cargo run --release -p fnzero-safe-app-services --example extension_recovery_fixtures -- \
  apps/extension/test/fixtures/desktop-backups.json
```

The fixture password is `local-fixture-password`; all fixture keys and phrases are public test data. Regenerating uses randomized encryption salts/nonces.

For the optional integration test, install Foundry's Anvil and obtain the official Safe 1.4.1 artifacts from `@safe-global/safe-contracts`. Set `SAFE_ARTIFACTS_DIR` to the package's `build/artifacts/contracts` directory:

```bash
ANVIL_BIN=/absolute/path/to/anvil \
SAFE_ARTIFACTS_DIR=/absolute/path/to/package/build/artifacts/contracts \
  npm run test:safe-local
```

The test starts an ephemeral local chain, installs verified Safe runtime code, creates/funds a Safe, executes a 2/2 transaction, checks its receipt, rejects replay/code tampering and transfers a six-decimal ERC-20. It requires no public-chain funds. `test/fixtures/TestToken.json` is compiled from the adjacent Solidity source with solc 0.8.24. For manual UI testing, run `scripts/local-test-chain.mjs` with the same environment variables; it serves a disposable RPC at `127.0.0.1:18545` and the test DApp at `127.0.0.1:18777`. Stop it with Ctrl-C.

Before the visual redesign, release validation also exercised plaintext recovery, account import, persisted custom RPC, ERC-20 sending, Safe creation/proposal/signature merge/execution, DApp connect/sign/send/reject, Solana message signing and locked-wallet re-review in Chrome for Testing. The new visual design and theme persistence still require browser acceptance testing. Public-network Solana transfers and every supported EVM network were not exercised end-to-end.

## Security model

- The vault is encrypted with PBKDF2-SHA-256 (600,000 iterations) and AES-256-GCM before storage.
- Decrypted keys exist only in the Manifest V3 service worker and are cleared after five minutes of inactivity, explicit lock, or worker suspension. An open wallet/approval UI checks session status without extending the inactivity timeout.
- Page scripts never receive private keys or the wallet password.
- A content-script bridge validates top-level HTTPS/localhost origins before forwarding provider requests.
- EVM and Solana permissions are recorded per origin and per chain family.
- DApp permissions are bound to the exact origin, selected account, and approved networks, and can be revoked per site.
- Connections, signatures and transactions use a separate confirmation window.
- EVM transactions are chain/account bound, simulated before signing, and decoded for common ERC-20, NFT approval, Permit and Permit2 risks.
- Solana transactions are signer-bound, decoded to show fee payer and programs, and simulated before broadcast.
- Provider messages are size bounded and confirmation queues are rate limited per origin.
- Arbitrary HTTPS dApps are supported, so host access is intentionally broad; the injected page bridge contains no key or password access.
- Enhanced token detection is enabled by default. EVM uses supported address indexers, Solana queries SPL Token and Token-2022 accounts, and USD prices use chain/address keys rather than token symbols.
- Google login and social recovery are intentionally disabled. They may only be enabled with OAuth authorization-code PKCE, strict redirect allowlisting, an audited MPC/threshold-key provider, and a documented recovery policy. OAuth identity must never be used as a private key or bypass local transaction confirmation.

This implementation follows public wallet interaction conventions such as EIP-1193 and EIP-6963. It does not copy MetaMask source code, branding, or visual assets.

The five-minute in-memory vault reduces exposure but cannot guarantee JavaScript string zeroization. Hardware-backed or native isolated signing remains a required hardening step before treating the extension as suitable for high-value custody.
