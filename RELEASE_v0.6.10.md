# FnzSafe v0.6.10 · Desktop + Chrome Extension

This combined release contains desktop 0.6.10 for macOS Apple Silicon and compiled Chrome extension 0.3.10 Preview, built from the same source commit. SDK crate versions remain independent.

## Changes

- Bind extension DApp approvals to the reviewed account and network throughout execution. Locking, wallet switching and permission revocation invalidate stale requests; serialized permission writes prevent delayed grants from restoring revoked access.
- Prevent delayed unlocks from undoing a lock and prevent recovery phrases from being returned after locking.
- Generate EIP-712 previews and signatures from the same validated payload. Reject unsigned extra fields, inconsistent primary types and domain schemas, including nested structures and arrays.
- Make local-wallet AI selling proposal-only. The runtime receives a separate read-only wallet capability; it cannot sign, unlock, export secrets or submit local-wallet trades. Users must review and execute trades in the wallet interface.
- Include persisted extension wallet renaming, pending-request badges, stronger recovery-group validation, Solana instruction previews, protection cleanup and timed backup clipboard cleanup.
- Harden desktop native permissions, session locking, Keychain biometric storage and signed application-resource verification; update vulnerable dependencies and CI checks.

## Update without removing wallets

Quit FnzSafe and replace only the application bundle. The application identifier remains `dev.sol-safekey.ui`; the macOS wallet database remains `~/Library/Application Support/FnzSafe/fnzero-safe.sqlite3`. Do not delete application-support directories or reset wallet data. Keep a private backup before updating. Existing encrypted records and passwords remain valid; Touch ID may require fresh authentication or reconfiguration after the security update.

For the extension, extract the compiled ZIP over the existing unpacked installation directory, then use Reload in `chrome://extensions`. Keep the directory and extension ID to preserve wallet storage and Passkeys; do not remove/reinstall the extension. New clipboard permissions support backup cleanup. OS clipboard history and synced copies cannot be erased by the extension.

## Validation

- 98 extension tests, TypeScript checking and production build.
- 203 desktop frontend tests and dependency/signing configuration checks.
- Both production builds completed; DMG and extension ZIP integrity verified.
- 429 Rust workspace tests passed; 4 environment-dependent tests remain ignored by their existing configuration.
- AI runtime tests and strict workspace Clippy checks passed.
- Real Touch ID enrollment changes, all third-party DApps and every chain are not covered by automated fixtures.

## Distribution status

This release is a draft. The macOS Apple Silicon installer is signed with Apple Development for local validation; it has not been notarized and is not approved for public distribution. The validation build omits protected Keychain entitlements because no provisioning profile is available: use wallet passwords; Touch ID is unavailable and existing Keychain items are not migrated or removed. No Developer ID Application certificate or Apple notarization credentials are available. Public publication remains blocked pending a compliant desktop build. The draft includes the desktop validation DMG, compiled extension ZIP and SHA-256 checksums; both version tags identify the same source commit.
