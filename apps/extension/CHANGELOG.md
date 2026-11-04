# Extension changelog

## 0.3.10 Preview — 2026-11-05

- Bind approvals to the reviewed account and network across asynchronous execution; cancel stale requests on lock, selection change and permission revocation.
- Prevent delayed unlocks and recovery exports from completing after lock. Serialize permission writes and revocation.
- Validate EIP-712 types, domains, nested fields and arrays; preview and sign the same normalized payload.
- Add persisted wallet renaming, pending-request badges, stronger backup validation, Solana instruction details and offscreen clipboard cleanup.
- Include the compiled extension with desktop 0.6.10 and matching checksums. Existing extension IDs and wallet storage must be retained on update.
- Validate with 98 extension tests, TypeScript checking and production compilation.

## 0.3.9 Preview — 2026-11-04

- Add editable wallet names to plaintext private-key and recovery-phrase imports, with duplicate/length validation and encrypted persistence.
- Open the import form directly from the wallet switcher and retain its input when Passkey verification is cancelled.
- Move Passkey setup, unlock, import, export and approval verification into a centered window, with cancellation, timeout and one-use result handling. Existing Passkeys retain their extension origin.
- Include the new verification page in the compiled ZIP. Publish alongside rebuilt desktop 0.6.9, retaining its wallet import, balance refresh and DApp fixes.
- Validate with 77 unit tests, TypeScript checking and an isolated browser flow with mocked WebAuthn. Native Google/device prompts are outside the mock test coverage.

## 0.3.8 Preview — 2026-11-03

- Rebuild from the same release commit as desktop 0.6.8, which clarifies private-key import passwords and prevents reimport from bypassing the local wallet password.
- Preserve existing extension behavior, including manual Safe discovery and wallet recovery.
- Both release pages include the desktop installer, compiled extension ZIP, and SHA-256 checksums.

## 0.3.7 Preview — 2026-11-03

- Rebuild alongside desktop 0.6.7, which fixes DApp switching deadlocks and preserves cached wallet balances during background refresh.
- Retain manual Safe discovery, address-based import, and Safe creation.
- Include both compiled clients and checksums on both release pages.

## 0.3.6 Preview — 2026-11-03

- Rebuild the compiled Chrome extension alongside desktop 0.6.6, which fixes a native DApp deadlock after wallet switching.
- Preserve manual Safe discovery, address-based Safe import, and Safe creation. No automatic chain scanning is introduced.
- Both release pages include the desktop installer, extension ZIP, and SHA-256 checksums.

## 0.3.5 — 2026-11-03

- Rebuild alongside desktop 0.6.5 for the combined release. Keep discovery opt-in, address-based Safe addition, and the 0.3.4 interaction fixes.
- Desktop now also waits for an explicit Find onchain Safes action; opening the page or switching wallet/network does not scan automatically.

Validation: 73 automated tests, TypeScript checking and production packaging.

## 0.3.4 — 2026-11-03

- Load only locally saved Safes by default. Empty wallets no longer start chain scans or show scan errors, zero-count headings or irrelevant filters.
- Make address-based Safe addition the primary action. Verify the entered address without scanning factory history.
- Move optional onchain discovery into its own page with an explicit Start action. Pause when leaving, keep failures scoped to that page and place RPC diagnostics behind a disclosure.

Validation: 73 automated tests, TypeScript checking, production packaging and browser verification of zero automatic scan requests, address-based addition and isolated scan failures.

## 0.3.3 — 2026-11-03

- Recover Safe 1.4.1 accounts from canonical factory history after local cache loss, with verified current ownership, progress, pause/continue and actionable errors.
- Organize multisig as account list, account details and individual proposal operations. Separate owners from proposals, put advanced fields behind disclosure, and show immediate loading skeletons and spinners.
- Group settings into wallet management and preferences, with dedicated appearance/language, security, RPC, privacy, sites and backup pages. Preserve password/Passkey authorization and add pending/error feedback.
- Import Transaction Builder files as single calls or verified atomic CALL-only batches. Share batch encoding and validation with desktop, with per-call review before signatures or execution.
- Anchor DApp approval windows to the requesting browser window and clean up approvals that expire while opening.

Validation: 73 automated tests, TypeScript checking, production build, official-contract Anvil recovery/batch integration, and synthetic browser checks of Safe navigation, loading feedback, settings navigation and light/dark themes.

## 0.3.2 — 2026-11-03

- Default the extension's Solana mainnet RPC to API-key-free PublicNode, after the official endpoint returned HTTP 403 for browser-origin requests. Keep official devnet and desktop defaults unchanged; preserve explicit custom RPC settings.
- Crop desktop-only transparent margins from extension artwork and supply native 16/32/48/128 pixel icons for the toolbar and extension manager.

Validation: 72 automated tests, TypeScript checking and production build. Includes default/override RPC regression checks and browser verification of the updated installation.

## 0.3.1 — 2026-11-03

- Isolate injected bundles from page globals. EIP-6963 announcements retain the FnzSafe provider when Phantom, MetaMask or another extension replaces a legacy global provider.
- Validate Solana mainnet/devnet RPCs against full genesis hashes instead of truncated chain identifiers. Keep official defaults and display actionable HTTP 403/429 errors.
- Add BNB Smart Chain Testnet (97), including reviewed DApp network switching. Reject unknown networks with error 4902 before opening a confirmation window.
- Add production-bundle coexistence tests, full-hash/balance RPC regressions, and approved network-switch tests.

Validation: 72 automated tests, TypeScript checking and a production build. Manual Chrome validation confirmed Uniswap opens FnzSafe's own approval window with other wallets installed. X404 connected a test account and switched to BNB Testnet successfully. Official Solana devnet and API-key-free PublicNode mainnet balance refreshes succeeded in a separate test wallet. The official mainnet endpoint still returned HTTP 403 for browser-origin requests; defaults remain unchanged.

## 0.3.0 — 2026-11-03

- Create additional multichain wallets with one click and one mnemonic per wallet. No mandatory phrase display or backup wizard. Names increment automatically and can be edited before creation.
- Switch wallets using name-only tabs on the left and chain/address rows on the right. Copy independently, or select a row to change wallet and network together.
- Separate legacy imported keys from mnemonic groups unless their derivation can be verified. Preserve existing account IDs and keys; retain custom derivation paths in full backups.
- Add English, Simplified Chinese, Traditional Chinese and automatic browser language selection, shared with approval windows.
- Export a selected mnemonic or chain private key as encrypted JSON, plaintext, a local QR code, or ordered plaintext fragments. Exports require password/Passkey verification and hide automatically.
- Support Bitcoin Native SegWit and Taproot import selection. Encrypted Bitcoin key exports preserve address metadata in extension format.
- Default idle lock to 15 minutes, configurable to 5, 15, 30 or 60 minutes. Actual UI activity resets the timer; polling does not. Keep an unlocked in-memory session alive through ordinary Chrome worker-idle termination.
- Use version 2 vaults for multiple mnemonic roots; retain version 1 import support. Grouped vaults are not readable by extension 0.2.0.

Validation: 66 automated tests, TypeScript checking, production build, and manual Chrome for Testing validation of creation, grouping, chain switching, copying, languages, encrypted download/restoration, QR and fragment exports. Bitcoin/TRON sending remains unavailable. Robinhood automatic discovery still depends on its unavailable external indexer.

## 0.2.0 — 2026-11-03

Introduced the layered light/dark interface, automatic first wallet, browser-bound default storage and PRF-based Passkey protection. Real Passkey enrollment and lock/unlock were confirmed by the user.
