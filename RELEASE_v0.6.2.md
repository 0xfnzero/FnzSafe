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

## Chrome extension — 0.3.2 Preview

The desktop installer and compiled browser extension are both available in **Assets** below:

- `FnzSafe_0.6.2_aarch64.dmg`: desktop application for macOS Apple Silicon; verify with `SHA256SUMS`.
- `FnzSafe-extension-0.3.2.zip`: compiled Chrome extension; verify with `SHA256SUMS-0.3.2.txt`.

Extension installation:

1. Download `FnzSafe-extension-0.3.2.zip` from Assets, not GitHub's automatic Source code archives.
2. Extract it into a permanent folder.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and choose the folder containing `manifest.json`.
5. Pin FnzSafe from Chrome's extensions menu.

No Node installation, source build, or terminal commands are required for users. Standard Chrome restricts off-store CRX installation, so this release provides the compiled ZIP for Load unpacked. It is not a Chrome Web Store installation or an automatic updater.

For updates, replace files in the same folder, click **Reload**, refresh DApp tabs, and unlock the wallet. Keep the path stable to preserve the extension ID and Passkey scope.

The extension includes multichain wallet creation, localized light/dark UI, encrypted backups, Safe multisig, isolated provider routing, BNB Testnet, and API-key-free PublicNode as its Solana mainnet default. Desktop RPC defaults are separate. Validation: 72 automated tests, type checking, production build, and browser checks of Uniswap approval routing, X404 connection/network switching, and Solana balance refresh.

The extension asset was added from the independently versioned [`extension-v0.3.2`](https://github.com/0xfnzero/FnzSafe/releases/tag/extension-v0.3.2) build, commit `6535abf64956bfb4fe261e52906cbac17f052d57`. Desktop binaries and the existing `v0.6.2` tag are unchanged. SDK crates retain their independent versions. Intel Mac, Windows, Linux and mobile installers are not included here.

## Validation

- 191 frontend and program-close unit tests passed.
- TypeScript, lint, sensitive-input checks, and the production frontend build passed.
- Browser regression checks covered loading animations, reduced motion, retained balances during refresh, asset details, transfer layouts, transaction history, settings themes and narrow layouts, and slow or failed native transfers and EVM contract calls.
- The macOS application and DMG were rebuilt for this version; installer integrity, bundle version, and ad-hoc code signatures were checked.

Browser regression checks used mocked APIs. No user private keys or public-network transactions were used.
