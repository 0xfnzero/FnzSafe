# FnzSafe Mobile

Flutter mobile app for iOS and Android.

## Scope

Mobile v1 includes:

- Wallet creation, import, unlock, export, removal, and switching
- SOL/SPL balances, token list, mint info, and transaction history
- SOL, SPL token, and WSOL payment workflows
- Password unlock, TOTP, biometric confirmation, and sensitive log filtering
- PumpFun/PumpSwap sell and cashback workflows
- dApp WebView with Solana provider injection and user-confirmed signing
- Squads multisig create, inspect, approve, reject, execute, and SOL/SPL payment proposals

Mobile v1 excludes Program deploy, Program upgrade, Program source build, and generic Program invocation.

## Tooling

This workspace expects Flutter and `flutter_rust_bridge_codegen` to be installed.

```sh
./tool/bootstrap_mobile.sh
cargo install flutter_rust_bridge_codegen
./tool/generate_bridge.sh
```

Run those commands from `apps/mobile` after installing the Flutter SDK. The
checked-in Dart scaffold is intentionally small so the generated iOS/Android
platform folders come from your installed Flutter version.

Internal release testing is tracked in `../../docs/mobile/INTERNAL_TEST_CHECKLIST.md`.
