# FnzSafe Chrome Extension v0.2.0 Preview

This release brings desktop-compatible wallet recovery, verified custom RPC settings, manual ERC-20 management, transaction reviews and Safe multisig to the Chrome extension.

## Changes

- Rebuilt the wallet as a Chrome side panel with a distinct blue balance card, layered asset panels, outlined controls, clear navigation selection and coordinated Light, Dark and System palettes.
- Open directly into an automatically created default wallet. Preserve the same accounts across extension restarts, and require protection before signing.
- Add password or WebAuthn PRF-based Passkey protection. Passkey enrollment verifies a subsequent assertion before migrating the vault; encrypted exports use a separate backup-file password for portability.
- Add searchable account/network panels, local receive QR codes, copy feedback, token details, token-specific sending and keyboard focus handling.

- Import plaintext recovery phrases and EVM, Solana, Bitcoin or TRON private keys. Restore extension encrypted backups, Web3 keystore v3 and supported desktop password-encrypted key/mnemonic backups.
- Append accounts without replacing the existing vault and export an encrypted backup containing all imported accounts.
- Configure per-network EVM and Solana RPC endpoints with chain ID/genesis checks, restore built-in defaults and redact endpoint credentials from errors.
- Import ERC-20 contracts directly through RPC, preview precise native/token transfers and inspect transaction receipts.
- Create and open verified Safe 1.4.1 wallets; propose, export/import/merge, sign and execute transactions with EOA owners. Verify hashes, deployment code, thresholds, nonces and Safe execution events.
- Bind transaction reviews to the selected account, network and RPC. Re-review after unlocking, display decoded message content, reject stale reviews and clear balance caches after submission.
- Handle DApp page navigation and service-worker session changes more reliably.

## Installation

1. Use Chrome 114 or newer. Download `FnzSafe-extension-0.2.0.zip` and verify it against `SHA256SUMS`.
2. Extract the archive into a permanent directory.
3. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**.
4. Select the extracted directory containing `manifest.json`, then click the toolbar icon to open the side panel.

This is an unpacked Chrome extension distribution, not a Chrome Web Store release. Keep the installed directory in place; updates are manual. Desktop releases are published separately; this extension preview does not replace the latest desktop release.

## Validation

- TypeScript check, production build and 53 automated extension tests passed.
- Five encrypted compatibility fixtures were generated with the actual Rust desktop implementation and restored by the extension.
- Local Anvil integration passed Safe creation, 2/2 signing/execution, receipt verification, stale-nonce rejection, deployment-code tampering rejection and six-decimal ERC-20 transfer/replay checks.
- Before the visual redesign, Chrome UI testing passed plaintext phrase/private-key recovery, custom RPC persistence, manual token import/transfer, Safe proposal/signature merge/execution, EVM DApp connect/sign/send/reject, Solana message signing, and locked-wallet unlock/re-review.
- The EVM UI signature and submitted transaction receipts were independently verified. All transaction tests used disposable local accounts, with no public-chain funds.

The final interface was also tested in Chrome and Chrome for Testing: light/dark themes and persistence, real side-panel layout, automatic first-open wallet creation and restart persistence, searchable account/network switching, receive QR/copy feedback and token-specific send selection. Passkey/password setup choices were inspected. The user subsequently confirmed successful Passkey registration, including the required PRF assertion. The user also confirmed locking and successfully unlocking the same wallet with the Passkey. Automated Passkey tests use mocked browser responses; the agent did not perform user verification.

## Current limitations

- A newly created wallet uses browser-bound IndexedDB encryption until protected. This is not password/Passkey protection. Protect and back up before adding funds; clearing extension storage can lose an unbacked-up wallet.
- Passkey encryption requires a compatible PRF provider and the same extension ID. Keep the installation directory stable, preserve the recovery phrase and use a password if the provider is unsupported. Real enrollment was performed and confirmed by the user, separately from the automated tests.

- Bitcoin/TRON support recovery and address display, not transaction signing/broadcasting.
- Multisig support in this extension is EVM Safe 1.4.1 only; Solana Squads workflows are not included. Safe operations support verified deployments, EOA signatures, CALL and zero gas refunds; contract owners and delegate calls are unsupported.
- Robinhood automatic token discovery remains unavailable (Issue #8 stays open). Custom RPC and manual ERC-20 import provide a workaround; they do not restore the external indexer.
- Public-network Solana transfers and every configured EVM chain were not tested end-to-end. These checks do not constitute an independent security audit.

See `apps/extension/README.md` for supported recovery formats, security boundaries and test reproduction steps.
