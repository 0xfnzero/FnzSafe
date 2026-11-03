# Extension changelog

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
