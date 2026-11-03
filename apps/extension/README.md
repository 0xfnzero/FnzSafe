# FnzSafe Chrome Extension 0.3.9

Manifest V3 wallet extension for EVM and Solana. Bitcoin and TRON support key recovery and address display; transaction signing and broadcasting for these families remain disabled.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package  # compiled ZIP and checksum in release/extension; requires Python 3
```

Load `apps/extension/dist` as an unpacked extension from `chrome://extensions`. Chrome 114 or newer is required. Click the toolbar icon to open the wallet in the side panel.

## Appearance

Choose **Light**, **Dark** or **System** from the header or Settings → Appearance & language. The choice is stored locally and shared by the wallet and DApp confirmation windows. System follows the OS appearance. Toolbar icons use a dedicated crop of the existing artwork, with native 16/32/48/128 pixel assets, so desktop transparent margins do not shrink the visible toolbar mark. Both palettes distinguish the page background, balance card, asset panel, controls and selected navigation. Searchable account/network panels, local receive QR codes, token details, token-specific sending, copy feedback and keyboard focus handling are included.

## First open and wallet protection

First open creates one recovery-phrase wallet locally and opens the asset screen, with derived accounts for the supported chain families. Reopening or restarting the extension preserves it. Existing encrypted wallets remain locked and are never replaced.

Before protection is configured, the default wallet is stored in IndexedDB as AES-GCM ciphertext alongside a nonextractable browser CryptoKey. This is browser storage, **not password or Passkey protection**. Signing is blocked until protection is configured. Protect and back up before receiving funds; clearing the extension's storage can permanently remove an unbacked-up wallet.

Choose **Protect wallet** to set a password or a Passkey. Passkey mode requires a WebAuthn provider supporting the PRF extension: a verified assertion must return a 32-byte PRF output, which encrypts the vault. A credential ID or public assertion is never used as an encryption key. Unsupported providers fail with a password alternative. Enrollment and unlock require user verification; the user confirmed successful real-browser enrollment, including the required PRF verification. The user also confirmed locking and successfully unlocking the same wallet with the Passkey.

Passkeys are scoped to the extension ID. Keep the installation path stable for unpacked extensions and retain an offline recovery phrase. Passkey sync alone is not a wallet backup. Passkey-protected encrypted exports require a separate backup-file password so they can be restored without the original credential. Imported private keys have independent backup/export controls; another wallet’s phrase does not recover them.

## Recovery, networks and assets

- Restore a plaintext BIP-39 phrase or import an individual EVM/TRON hex key, Solana base58 key / seed hex / JSON key array, or Bitcoin mainnet compressed WIF / hex key. Bitcoin imports can select Native SegWit or Taproot; encrypted extension key exports preserve the original address type.
- Restore extension encrypted backups, standard Web3 keystore v3, and supported FnzSafe desktop password-only key/mnemonic backups. Desktop custom derivation paths are preserved. Hardware-backed, social/MPC and other desktop backup schemes are not supported.
- Settings can append accounts to the existing encrypted vault and export an encrypted backup after password or Passkey verification. New mnemonic imports retain their own root and wallet group. Imported keys remain separate from mnemonic wallets.
- Plaintext private-key and recovery-phrase imports have an editable wallet name. Names are saved with the encrypted wallet, limited to 80 characters, and checked for duplicates; encrypted backup imports use the existing recovery flow without this name override.
- Passkey setup, unlock, import and export use a separate window centered within the available screen. Choose **Continue with Passkey** there to open the browser-owned prompt. Successful verification closes the window and resumes the original operation; closing or cancelling returns control to the wallet. Existing Passkeys keep the same extension origin and do not need enrollment again.
- Configure HTTPS RPC endpoints per EVM network and Solana cluster, with chain ID / genesis verification. HTTP is allowed only for localhost testing. Reset restores the built-in endpoint. Custom endpoints do not silently fall back to another provider.
- Add ERC-20 contracts directly, read decimals and balances through the selected RPC, preview native/ERC-20 transfers, and check local submission receipts in Activity.
- Robinhood automatic token discovery remains unavailable (Issue #8). Custom RPC plus manual token import is a workaround, not a repair of the external indexer.

## DApp compatibility and RPC availability

EVM discovery uses EIP-6963 and requests use EIP-1193; Solana discovery uses Wallet Standard. There is no DApp domain allowlist. A site must support these standards and the requested network/method. BNB Smart Chain Testnet (97) is included. Unknown EVM networks return error 4902 without opening an unusable confirmation; arbitrary DApp-supplied networks are not installed automatically.

Injected bundles use an isolated IIFE scope so other extensions replacing `window.ethereum` or `window.solana` cannot redirect FnzSafe's announced provider. Regression tests execute the production bundle as a classic script with another wallet injected both before and after it.

Solana validation uses the full genesis hash. The browser extension defaults to API-key-free PublicNode for mainnet and the official endpoint for devnet. Desktop RPC defaults are managed separately and are unchanged by this extension release. Existing explicit RPC overrides are preserved. During release testing, the official mainnet endpoint returned HTTP 403 for browser/extension Origin headers, while requests without Origin and official devnet requests succeeded. This external restriction is not repaired by changing the wallet's genesis check. HTTP 403/429 errors now identify access denial/rate limiting. An explicitly configured public endpoint such as `https://solana-rpc.publicnode.com` works without an API key; public service availability and rate limits still apply. No silent fallback is used. Reset restores the extension's built-in endpoint for that network.

Manual validation for 0.3.1 confirmed Uniswap opens the FnzSafe approval window alongside Phantom, MetaMask, TokenPocket and Binance Wallet. A separate test wallet connected to X404 and switched to BNB Testnet; official Solana devnet and PublicNode mainnet balances refreshed successfully. No asset-transfer transactions were submitted.

## Wallets, languages and backups

The wallet picker has wallet-name tabs on the left and per-network addresses on the right. Each row has independent copy and select controls; selection updates the account and network together. New wallets use one BIP-39 phrase for EVM, Solana, Bitcoin (Taproot and Native SegWit) and TRON. Creation is immediate, with no forced phrase display or backup confirmation. The name field is prefilled with the next sequential Wallet number and can be edited before creation. Previously imported private keys are grouped separately when they cannot be recovered from the recorded mnemonic's supported paths.

Settings → Language offers English, Simplified Chinese, Traditional Chinese and automatic browser detection. Language and appearance persist across wallet and approval windows. Addresses, user names, token names and raw transaction data are not translated.

**Backup & export** targets the active wallet's mnemonic or a selected chain private key. It supports encrypted JSON files/strings, plaintext, locally generated QR codes, and ordered plaintext fragments. Password/Passkey verification is required before export. Results clear on exit, lock detection or after 90 seconds. Fragments are simple ordered pieces, not Shamir shares; all pieces are required. Mnemonic fragments keep whole words.

Mnemonic and EVM/Solana/TRON key encryption uses the desktop password-secret envelope (Argon2id and AES-GCM). Bitcoin encrypted key exports use a single-account extension vault to preserve the address type and path; these require the extension importer. Plaintext Bitcoin recovery must select the matching address type. Full-vault exports preserve every mnemonic root and imported key. Custom derivation paths require a full encrypted backup to preserve exact account metadata in addition to the phrase. Version 2 grouped vaults require extension 0.3.0 or newer; version 0.2.0 cannot open them. Existing version 1 vaults remain readable.

Manual validation for 0.3.0 used public test accounts in Chrome for Testing: one-click creation, legacy grouping, wallet/chain switching, copy without selection, all three languages, optional backup formats, and downloaded encrypted-key restoration. No real user's secrets were used in export tests.

## Safe multisig

Create or open a verified Safe 1.4.1 account on the selected EVM network. Creation supports 2–50 EOA owners and a threshold of at least two. Proposals can send native assets or contain explicit contract calldata; export/import JSON to collect and merge owner signatures. Proposal hashes use the desktop-compatible format and are checked locally and on-chain. Execution requires the threshold and current nonce, simulates the transaction, and checks Safe execution events in its receipt.

Safe navigation is organized as account list → account details → proposal details. Creation, address import, proposals and Transaction Builder imports each have a focused page with a back action. Account details separate proposals from owners. Settings likewise uses grouped entries with dedicated appearance, security, RPC, privacy, connections and backup pages.

Opening Safe only loads saved local accounts; it never scans chain history automatically. **Add existing Safe** checks and saves the address you enter. Optional **Find onchain Safes → Start scan** scans canonical Safe 1.4.1 factory history from newest to oldest and verifies current ownership before caching accounts. Clearing the local Safe cache no longer requires remembering each address. Scans show progress and support pause, continue and retry; RPC errors retain existing accounts. Scanning may take time on large histories, resumes only within the current mounted view, and does not recover offchain proposals, signatures or labels. Other factories require adding an address.

Transaction Builder JSON imports support one CALL or a reviewed atomic CALL-only batch using the verified canonical MultiSendCallOnly deployment. Desktop and extension share batch encoding and proposal validation. Only verified canonical Safe deployments, EIP-712 EOA signatures and zero gas refunds are supported. Arbitrary delegate calls, smart-contract owner signatures and a hosted transaction service are not supported. Raw contract calldata must be independently understood before signing.

## Installation

Version 0.3.9 is an extension preview release. Passkey enrollment has been confirmed by the user; the user also confirmed locking and successfully unlocking the same wallet with the Passkey. The password path remains available.

Download and extract `FnzSafe-extension-0.3.9.zip` from **Assets** on the [latest combined Release](https://github.com/0xfnzero/FnzSafe/releases/latest). The same compiled artifact is also available under `extension-v0.3.9`. GitHub's automatic Source code downloads are not installable extension packages. End users do not need Node or a build tool. In Chrome, open `chrome://extensions`, enable Developer mode and choose **Load unpacked**, then select the extracted directory containing `manifest.json`. Keep that directory in place. When updating an existing unpacked installation, replace its files in the same directory and use Reload; changing the path changes the extension ID and can break Passkey access. This is an unpacked developer distribution, not a Chrome Web Store listing; updates are manual.

For local development, load `dist` after building. Use a separate Chrome profile and public test accounts for development; never fund fixture accounts on a public network.

## Reproducible validation

`npm test` covers RPC validation and redaction, plaintext recovery, encrypted backup formats, Safe signatures/proposals, vault migration, default-wallet persistence and protection migration, mocked Passkey PRF validation, DApp permission/security boundaries and serialized background imports. The current suite contains 77 passing tests, including multiple mnemonic roots, named imports and failed-write preservation, scoped exports, encrypted backup restoration, locale completeness, atomic account/network selection, idle-lock settings, and Passkey window sender validation and cancellation. The desktop compatibility fixtures were produced independently by the Rust implementation:

```bash
# Run from the repository root (requires the usual Rust/OpenSSL build dependencies).
cargo run --release -p fnzero-safe-app-services --example extension_recovery_fixtures -- \
  apps/extension/test/fixtures/desktop-backups.json
```

The fixture password is `local-fixture-password`; all fixture keys and phrases are public test data. Regenerating uses randomized encryption salts/nonces.

`npm run test:e2e:import-passkey` exercises Passkey setup, window placement, cancellation/retry, named private-key import, and unlock/name persistence in a disposable Chrome profile. Set `FNZSAFE_E2E_CHROME` to a Chrome for Testing executable and optionally `FNZSAFE_E2E_SCREENSHOT_DIR` to save screenshots. WebAuthn responses are mocked; real Google Password Manager/device verification and its native dialog appearance require manual validation. No existing browser profile or funded wallet is used.

For the optional integration test, install Foundry's Anvil and obtain the official Safe 1.4.1 artifacts from `@safe-global/safe-contracts`. Set `SAFE_ARTIFACTS_DIR` to the package's `build/artifacts/contracts` directory:

```bash
ANVIL_BIN=/absolute/path/to/anvil \
SAFE_ARTIFACTS_DIR=/absolute/path/to/package/build/artifacts/contracts \
  npm run test:safe-local
```

The test starts an ephemeral local chain, installs verified Safe runtime code, creates/funds a Safe, executes a 2/2 transaction, checks its receipt, rejects replay/code tampering and transfers a six-decimal ERC-20. It also tests owner-based recovery, wrong-network rejection, desktop-compatible batch signatures, batch tamper rejection and atomic execution. It requires no public-chain funds. `test/fixtures/TestToken.json` is compiled from the adjacent Solidity source with solc 0.8.24. For manual UI testing, run `scripts/local-test-chain.mjs` with the same environment variables; it serves a disposable RPC at `127.0.0.1:18545` and the test DApp at `127.0.0.1:18777`. Stop it with Ctrl-C.

Before the visual redesign, release validation also exercised plaintext recovery, account import, persisted custom RPC, ERC-20 sending, Safe creation/proposal/signature merge/execution, DApp connect/sign/send/reject, Solana message signing and locked-wallet re-review in Chrome for Testing. The final design was checked in Chrome and Chrome for Testing: light/dark themes and persistence, side-panel layout, first-open wallet creation and restart persistence, account/network search and switching, receive QR/copy feedback, and token-specific send selection. Passkey/password protection choices were inspected, and the user subsequently confirmed successful Passkey enrollment. The agent did not enter credentials or perform the user verification. Public-network Solana transfers and every supported EVM network were not exercised end-to-end.

## Security model

- Protected vaults use PBKDF2-SHA-256 (600,000 iterations) and AES-256-GCM. Password mode derives from the chosen password; Passkey mode derives from the PRF output. The initial browser-bound wallet has the separate storage boundary described above.
- Protected signing keys and the authorization needed for one-click creation are encrypted with a nonextractable, in-memory AES key. Mnemonic roots are removed from the signing session. The session and encrypted authorization are cleared on lock. No password/PRF authorization is persisted.
- Idle lock defaults to 15 minutes and supports 5/15/30/60 minutes. Visible UI clicks, typing and scrolling reset it; status polling and DApp reads do not. While unlocked, an extension API heartbeat prevents ordinary Chrome worker-idle termination before that deadline. Explicit lock, actual worker termination, extension reload and browser restart still discard the session.
- Page scripts never receive private keys or the wallet password.
- A content-script bridge validates top-level HTTPS/localhost origins before forwarding provider requests.
- EVM and Solana permissions are recorded per origin and per chain family.
- DApp permissions are bound to the exact origin, selected account, and approved networks, and can be revoked per site.
- Connections, signatures and transactions use a separate confirmation window.
- EVM transactions are chain/account bound, simulated before signing, and decoded for common ERC-20, NFT approval, Permit and Permit2 risks.
- Solana transactions are signer-bound, decoded to show fee payer and programs, and simulated before broadcast.
- Provider messages are size bounded and confirmation queues are rate limited per origin.
- Arbitrary HTTPS dApps are supported, so host access is intentionally broad; the injected page bridge contains no key or password access.
- Enhanced token detection is off for automatically created wallets; older/imported vault settings are preserved. EVM uses supported address indexers, Solana queries SPL Token and Token-2022 accounts, and USD prices use chain/address keys rather than token symbols.
- Google login and social recovery are intentionally disabled. They may only be enabled with OAuth authorization-code PKCE, strict redirect allowlisting, an audited MPC/threshold-key provider, and a documented recovery policy. OAuth identity must never be used as a private key or bypass local transaction confirmation.

This implementation follows public wallet interaction conventions such as EIP-1193 and EIP-6963. It does not copy MetaMask source code, branding, or visual assets.

The time-limited in-memory vault reduces exposure but cannot guarantee JavaScript string zeroization. Hardware-backed or native isolated signing remains a required hardening step before treating the extension as suitable for high-value custody.
