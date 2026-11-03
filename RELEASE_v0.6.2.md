# FnzSafe v0.6.2

## Changes

- Redesign the desktop Safe multisig workspace, including account cards, search, account details, signature progress, transaction forms, and creation review. Opening a Safe now shows its detail view immediately with animated loading placeholders.
- Refresh the wallet overview, asset details, send forms, settings center, and tool navigation with consistent spacing, cards, controls, and readable light, dark, and deep-sea themes.
- Add animated skeletons, refresh progress bars, button spinners, and persistent operation feedback with elapsed time across wallet assets, transaction history, network lists, DeFi data, proposals, and long-running operations. Existing balances remain visible during refresh.
- Prevent duplicate submissions and input changes while transfer previews, sends, and EVM contract calls are pending. Restore controls after failures and distinguish failed requests from empty results.
- Improve Safe read-request timeouts and receipt-check feedback without automatically retrying approved writes. Respect the system's reduced-motion preference.

## Installation

Download `FnzSafe_0.6.2_aarch64.dmg` for macOS Apple Silicon and drag FnzSafe into Applications. Verify the download against `SHA256SUMS`.

The application is ad-hoc signed. It does not have an Apple Developer ID signature and is not notarized. After verifying the source, the first launch may require approval in System Settings → Privacy & Security.

This release packages the desktop application only. No updated browser extension, Intel Mac, Windows, Linux, or mobile installer is included. SDK crates retain their independent versions.

## Validation

- 191 frontend and program-close unit tests passed.
- TypeScript, lint, sensitive-input checks, and the production frontend build passed.
- Browser regression checks covered loading animations, reduced motion, retained balances during refresh, asset details, transfer layouts, transaction history, settings themes and narrow layouts, and slow or failed native transfers and EVM contract calls.
- The macOS application and DMG were rebuilt for this version; installer integrity, bundle version, and ad-hoc code signatures were checked.

Browser regression checks used mocked APIs. No user private keys or public-network transactions were used.
