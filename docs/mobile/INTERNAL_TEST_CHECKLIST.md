# FnzSafe Mobile Internal Test Checklist

## Build

- Run `apps/mobile/tool/bootstrap_mobile.sh` after installing Flutter.
- Run `apps/mobile/tool/generate_bridge.sh` after installing `flutter_rust_bridge_codegen`.
- Run `flutter analyze` and `flutter test` from `apps/mobile`.
- Build Android debug APK, Android release APK/AAB, and iOS archive.
- Android release signing:
  - Copy `apps/mobile/android/key.properties.example` to `apps/mobile/android/key.properties`.
  - Put the upload keystore outside source control and point `storeFile` at it.
  - Build with JDK 17: `flutter build appbundle`.
- iOS release signing:
  - Install the matching iOS platform from Xcode > Settings > Components.
  - Verify `xcrun simctl list runtimes` shows at least one iOS runtime.
  - Run `flutter build ios --no-codesign`, then configure signing/profile/archive in Xcode.

## Wallet

- Create a wallet and confirm no password appears in logs.
- Import a v2 keystore and unlock it.
- Reject wrong password attempts.
- Switch the active wallet.
- Export a keystore only after explicit user confirmation.

## Security

- Configure TOTP and reject an invalid code.
- Cancel biometric confirmation and verify the action is not signed.
- Confirm release logs do not contain private key, mnemonic, password, or TOTP secret values.

## Assets And Payments

- Refresh SOL/SPL balances on devnet.
- Preview a SOL payment and reject it.
- Preview a SOL payment and approve it.
- Scan a recipient QR code.
- Preview WSOL wrap, unwrap, and close ATA flows.

## dApps And Squads

- Open a dApp WebView.
- Verify `connect`, `disconnect`, `publicKey`, and `isConnected`.
- Preview and reject a dApp message request.
- Preview and approve a dApp transaction request.
- Preview and approve `signAllTransactions` with two devnet transactions.
- Preview and approve `signAndSendTransaction` against a funded devnet wallet.
- Load Squads multisig info and proposals.
- Preview Squads approve, reject, execute, and SOL/SPL payment proposal actions.
- Create a test Squads multisig on devnet.
- Create a SOL transfer proposal, approve/reject it from a member wallet, and execute after threshold.
- Create a SPL transfer proposal with a test mint and execute after threshold.

## Current Local iOS Blocker

- `xcrun simctl list runtimes` currently reports no installed runtimes on this machine.
- `xcodebuild` reports `iOS 26.5 is not installed` for the Runner scheme destination.
- iOS simulator/device build and archive must be rerun after installing the Xcode iOS platform/runtime.

## Out Of Scope

- Program deploy is not available on mobile.
- Program upgrade is not available on mobile.
- Program source build is not available on mobile.
- Generic Program invocation is not available on mobile.
