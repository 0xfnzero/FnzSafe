<div align="center">
    <h1>FnzeroSafe</h1>
    <h3><em>Local-first Solana and EVM wallet, secure keystore, desktop app, and iOS/Android app</em></h3>
</div>

<p align="center">
    <strong>FnzeroSafe is an open-source Solana and EVM wallet security workspace for encrypted keystores, desktop signing, mobile wallets, dApp signing, Pump trading, Squads multisig, bot integration, and advanced desktop-only Program workflows.</strong>
</p>

<p align="center">
    <a href="https://crates.io/crates/fnzero-safe-core">
        <img src="https://img.shields.io/crates/v/fnzero-safe-core.svg" alt="Crates.io">
    </a>
    <a href="https://docs.rs/fnzero-safe-core">
        <img src="https://img.shields.io/docs.rs/fnzero-safe-core/badge.svg" alt="Documentation">
    </a>
    <a href="https://github.com/0xfnzero/FnzeroSafe/blob/main/LICENSE">
        <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
    </a>
    <a href="https://github.com/0xfnzero/FnzeroSafe">
        <img src="https://img.shields.io/github/stars/0xfnzero/FnzeroSafe?style=social" alt="GitHub stars">
    </a>
</p>

<p align="center">
    <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust">
    <img src="https://img.shields.io/badge/Solana-9945FF?style=for-the-badge&logo=solana&logoColor=white" alt="Solana">
    <img src="https://img.shields.io/badge/EVM-3C3C3D?style=for-the-badge&logo=ethereum&logoColor=white" alt="EVM">
    <img src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js">
    <img src="https://img.shields.io/badge/Tauri-24C8DB?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri">
    <img src="https://img.shields.io/badge/Flutter-02569B?style=for-the-badge&logo=flutter&logoColor=white" alt="Flutter">
</p>

<p align="center">
    <a href="https://github.com/0xfnzero/FnzeroSafe/blob/main/README_CN.md">中文</a> |
    <a href="https://github.com/0xfnzero/FnzeroSafe/blob/main/README.md">English</a> |
    <a href="https://fnzero.dev/">Website</a> |
    <a href="https://t.me/fnzero_group">Telegram</a> |
    <a href="https://discord.gg/ckf5UHxz">Discord</a>
</p>

---

## Document Outline

1. [Project Overview](#1-project-overview)
   1. [What FnzeroSafe Is For](#11-what-fnzerosafe-is-for)
   2. [Product Editions](#12-product-editions)
   3. [Capability Matrix](#13-capability-matrix)
   4. [Platform Matrix](#14-platform-matrix)
2. [Repository Layout](#2-repository-layout)
3. [Development Environment](#3-development-environment)
   1. [Required Toolchains](#31-required-toolchains)
   2. [One-Time Setup](#32-one-time-setup)
   3. [Host Notes](#33-host-notes)
4. [Run In Development](#4-run-in-development)
   1. [Desktop App](#41-desktop-app)
   2. [iOS App](#42-ios-app)
   3. [Android App](#43-android-app)
   4. [CLI](#44-cli)
5. [Package For Release](#5-package-for-release)
   1. [Release Directory](#51-release-directory)
   2. [macOS Desktop](#52-macos-desktop)
   3. [Windows Desktop](#53-windows-desktop)
   4. [iOS](#54-ios)
   5. [Android](#55-android)
   6. [All Platforms](#56-all-platforms)
6. [Command Reference](#6-command-reference)
7. [Configuration](#7-configuration)
8. [Security Model](#8-security-model)
9. [Documentation](#9-documentation)
10. [Before Submitting To GitHub](#10-before-submitting-to-github)
11. [License](#11-license)

---

## 1. Project Overview

### 1.1 What FnzeroSafe Is For

FnzeroSafe is a local-first Solana and EVM wallet and key-management workspace. It combines a Rust core crate, an interactive CLI, a local desktop API, a Next.js web interface, a Tauri desktop shell, and a Flutter mobile app for iOS and Android.

| Area | Coverage |
|---|---|
| Wallets | Create wallets, import keystores/private keys/mnemonics, unlock wallets, export encrypted backups |
| Security | Password keystores, encrypted local API bodies, local API token, TOTP, biometric confirmation, sensitive log filtering |
| Assets | SOL balance, SPL Token accounts, Token-2022 accounts, mint metadata, transaction history |
| Payments | SOL transfer, SPL transfer, WSOL wrap/unwrap/close ATA |
| dApps | In-app WebView, Solana provider injection, message/transaction preview, user-confirmed signing |
| Squads | Squads v4 multisig create/info/proposals/approve/reject/execute, SOL/SPL payment proposals |
| Trading | Pump.fun and PumpSwap sell flows, cashback views and claims, SWQoS token configuration |
| Programs | Desktop-only Program deploy, upgrade, source build, authority and deployment workflows |
| Automation | Rust SDK, CLI helpers, local API, examples for bot integration |
| EVM | Built-in EVM chain registry, custom RPC-ready model, secp256k1 wallets, ERC-20 assets, EIP-1559 transfers, EIP-712/dApp signing |

### 1.2 Product Editions

| Edition | Path | Technology | Primary Use |
|---|---|---|---|
| Desktop app | `apps/desktop` | Next.js + Tauri + Rust API | Full local wallet console, dApp signing, Pump, Squads, Program workflows |
| Mobile app | `apps/mobile` | Flutter + `flutter_rust_bridge` + Rust core | iOS/Android wallet, assets, payments, dApp signing, Pump, Squads |
| Rust core / CLI | `crates/core` | Rust | Keystore, CLI, SDK-style integration and automation |
| Shared services | `crates/app-services` | Rust | Business logic shared by desktop and mobile |
| Mobile bridge | `crates/mobile-bridge` | Rust FFI | FRB-friendly API consumed by Flutter |

### 1.3 Capability Matrix

| Capability | Desktop | iOS | Android | Notes |
|---|---:|---:|---:|---|
| Wallet create/import/unlock/export | Yes | Yes | Yes | Secrets stay in encrypted keystores |
| SOL/SPL assets and history | Yes | Yes | Yes | Uses Solana RPC |
| SOL/SPL/WSOL payments | Yes | Yes | Yes | User confirmation required |
| EVM wallets and custom RPC chains | Yes | Yes | Yes | Built-in popular chains plus user-provided EVM RPC |
| EVM native/ERC-20 assets | Yes | Yes | Yes | Native balance, ERC-20 metadata, token balances |
| EVM native/ERC-20 transfers | Yes | Yes | Yes | EIP-1559 type-2 preferred; legacy gas fallback |
| EVM dApp signing/sending | Yes | Yes | Yes | `personal_sign`, `eth_signTypedData_v4`, `eth_signTransaction`, `eth_sendTransaction` |
| dApp message signing | Yes | Yes | Yes | WebView/provider flow on mobile |
| dApp transaction signing/sending | Yes | Yes | Yes | User confirmation required |
| Squads multisig | Yes | Yes | Yes | Create, proposals, approve/reject/execute |
| PumpFun/PumpSwap | Yes | Partial mobile integration | Partial mobile integration | Mobile submit flows continue to mature |
| Program deploy | Yes | No | No | Desktop-only by design |
| Program upgrade | Yes | No | No | Desktop-only by design |
| Program source build | Yes | No | No | Desktop-only by design |
| Generic Program invoke | Yes | No | No | Desktop-only by design |

### 1.4 Platform Matrix

| Platform | Status | Main Command | Output |
|---|---|---|---|
| Desktop development | Supported | `make dev` | Tauri app, Next.js on `127.0.0.1:3840`, API on `127.0.0.1:3841` |
| macOS desktop package | Supported on macOS | `make package-macos` | `release/macos/*.dmg` and `.app` |
| Windows desktop package | Supported on Windows runner | `make package-windows` | `release/windows/*.msi` and/or `.exe` |
| iOS app package | Supported with Xcode iOS platform/signing | `make package-ios` | `release/ios/*.app` or `.ipa` |
| Android app package | Supported | `make package-android` | `release/android/*.apk` and `.aab` |
| CLI | Supported | `cargo run -p fnzero-safe-core --features full -- start` | Interactive terminal wallet tools |

---

## 2. Repository Layout

```text
/
├─ Cargo.toml
├─ Makefile
├─ crates/
│  ├─ core/                      # Rust SDK and CLI binary: fnzero-safe
│  ├─ evm-services/              # Generic EVM chain, wallet, asset, fee, transaction, and dApp services
│  ├─ app-services/              # Shared wallet/assets/payments/dApp/Squads services
│  ├─ desktop-api/               # Local Axum API used by desktop/web
│  └─ mobile-bridge/             # flutter_rust_bridge FFI layer
├─ apps/
│  ├─ desktop/                   # Next.js UI and Tauri desktop shell
│  └─ mobile/                    # Flutter iOS/Android app
├─ packages/
│  └─ shared-contracts/          # Shared API contracts and interface notes
├─ examples/                     # Bot and keystore examples
├─ docs/                         # Internal testing and development notes
└─ release/                      # Package output directory, ignored by Git
```

The public product name is **FnzeroSafe**. Internal Cargo package names such as `fnzero-safe-core`, `fnzero-safe-desktop-api`, and `fnzero-safe-mobile-bridge` keep workspace crates unique.

---

## 3. Development Environment

### 3.1 Required Toolchains

| Tool | Recommended Version | Used For |
|---|---|---|
| Rust | 1.89+ | Workspace, CLI, desktop API, mobile bridge |
| Node.js | 20 or 22+ | Desktop web app |
| npm | 10+ | Desktop dependencies and scripts |
| Flutter / Dart | Flutter 3.24+ | iOS and Android app |
| Xcode | Current stable | macOS desktop package, iOS simulator/device/archive |
| Android Studio / SDK / NDK | Current stable | Android builds and emulators |
| JDK | 17 | Android Gradle builds |
| `cargo-ndk` | Latest | Android Rust bridge libraries |
| `flutter_rust_bridge_codegen` | FRB 2.x | Regenerating Dart/Rust bridge code |

### 3.2 One-Time Setup

```bash
rustup update
npm --version
flutter doctor -v
cargo install cargo-ndk
cargo install flutter_rust_bridge_codegen
npm --prefix apps/desktop install
cd apps/mobile && flutter pub get
```

Regenerate mobile bridge bindings after changing `crates/mobile-bridge/src/api.rs`:

```bash
cd apps/mobile
./tool/generate_bridge.sh
```

### 3.3 Host Notes

| Host | Notes |
|---|---|
| macOS | Required for macOS desktop packages and iOS builds. Install the matching iOS platform/runtime from Xcode > Settings > Components. |
| Windows | Recommended for `make package-windows` with the MSVC target and Visual Studio build tools. |
| Android | Use JDK 17. Override auto-detection with `ANDROID_JAVA_HOME=/path/to/jdk17 make package-android`. |
| iOS signing | Unsigned `.app` builds can use `make package-ios`; signed IPA/TestFlight builds require an Apple developer team, provisioning profile, and export options. |

---

## 4. Run In Development

### 4.1 Desktop App

Run from the repository root:

```bash
npm --prefix apps/desktop install
make dev
```

`make dev` stops stale local development processes first, then starts:

| Service | URL |
|---|---|
| English UI | `http://127.0.0.1:3840/en/` |
| Chinese UI | `http://127.0.0.1:3840/zh/` |
| Local API health | `http://127.0.0.1:3841/api/health` |

The local API is designed for loopback use only. Do not expose `3841` through a public proxy, tunnel, or port forward.

### 4.2 iOS App

```bash
cd apps/mobile
./tool/bootstrap_mobile.sh
flutter pub get
./tool/generate_bridge.sh
./tool/build_ios_native.sh
flutter run -d ios
```

iOS requirements:

1. Xcode command line tools are selected with `xcode-select`.
2. The matching iOS platform/runtime is installed in Xcode Components.
3. iOS deployment target is 15.0.
4. Physical devices and TestFlight require normal Xcode signing setup.

### 4.3 Android App

```bash
cd apps/mobile
./tool/bootstrap_mobile.sh
flutter pub get
./tool/generate_bridge.sh
./tool/build_android_native.sh
flutter run -d android
```

Android notes:

1. Android application id is `dev.fnzero.safe`.
2. Android `minSdk` is 26.
3. Rust bridge `.so` libraries are generated for `arm64-v8a`, `armeabi-v7a`, `x86`, and `x86_64`.
4. JDK 17 is recommended for Gradle.

### 4.4 CLI

```bash
cargo run -p fnzero-safe-core --features full -- start
```

Install the CLI locally from source:

```bash
cargo install --path crates/core --features full
fnzero-safe start
```

---

## 5. Package For Release

### 5.1 Release Directory

All package commands copy artifacts into the root `release/` directory:

```text
release/
├─ android/
│  ├─ app-release.apk
│  └─ app-release.aab
├─ ios/
│  └─ *.app or *.ipa
├─ macos/
│  ├─ FnzeroSafe.app
│  └─ FnzeroSafe_*.dmg
└─ windows/
   └─ *.msi and/or *.exe
```

`release/` is ignored by Git.

### 5.2 macOS Desktop

```bash
make package-macos
```

This runs the desktop production build and copies `.dmg` and `.app` artifacts into `release/macos/`.

### 5.3 Windows Desktop

```bash
make package-windows
```

This builds the Tauri Windows package and copies `.msi` and/or `.exe` artifacts into `release/windows/`.

Recommended build environment: a Windows runner with Rust, Node.js, npm, and Microsoft Visual Studio build tools installed. Cross-building Windows installers from macOS requires extra toolchain setup.

Override the target when needed:

```bash
TAURI_WINDOWS_TARGET=x86_64-pc-windows-msvc make package-windows
```

### 5.4 iOS

Unsigned local `.app` build:

```bash
make package-ios
```

Signed IPA build:

```bash
IOS_CODESIGN=true IOS_EXPORT_OPTIONS_PLIST=/path/to/ExportOptions.plist make package-ios
```

The command first builds the Rust iOS `FnzeroSafeMobileBridge.xcframework`, then runs the Flutter iOS package step and copies artifacts into `release/ios/`.

### 5.5 Android

```bash
make package-android
```

If JDK 17 is not auto-detected:

```bash
ANDROID_JAVA_HOME=/path/to/jdk17 make package-android
```

Android release signing:

```bash
cp apps/mobile/android/key.properties.example apps/mobile/android/key.properties
# Edit key.properties so storeFile, storePassword, keyAlias, and keyPassword point to your upload keystore.
make package-android
```

The command builds Rust Android native libraries, a release APK, and a release AAB, then copies artifacts into `release/android/`.

### 5.6 All Platforms

```bash
make package
```

This runs Android, iOS, macOS, and Windows package targets in sequence. For CI, run each platform on its native runner when possible.

---

## 6. Command Reference

| Command | Description |
|---|---|
| `make dev` | Start desktop development; stale local app/API processes are stopped first |
| `make package-macos` | Build macOS desktop package into `release/macos/` |
| `make package-windows` | Build Windows desktop package into `release/windows/` |
| `make package-ios` | Build iOS `.app` or signed `.ipa` into `release/ios/` |
| `make package-android` | Build Android APK/AAB into `release/android/` |
| `make package` | Build all package targets |
| `cargo fmt --all -- --check` | Check Rust formatting |
| `cargo check --workspace --all-features` | Check the full Rust workspace |
| `cargo test --workspace` | Run Rust tests |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | Run strict Rust linting |
| `npm --prefix apps/desktop run lint` | Run desktop lint and sensitive-input checks |
| `npm --prefix apps/desktop run build` | Build the Next.js static frontend |
| `cd apps/mobile && flutter analyze` | Analyze the Flutter app |
| `cd apps/mobile && flutter test --dart-define=FNZERO_MOBILE_DEV_BRIDGE=true` | Run Flutter tests with the dev bridge fallback |

---

## 7. Configuration

| Variable | Purpose |
|---|---|
| `FNZERO_SAFE_API_TOKEN` | Fixed local API token for desktop/web development |
| `FNZERO_SAFE_DB_PATH` | Override wallet database path. `make dev` uses `apps/desktop/data/fnzero-safe.sqlite3` and automatically copies an older `apps/desktop/data/sol-safekey.sqlite3` dev wallet database into that path when the new file does not exist. |
| `FNZERO_SAFE_ALLOWED_ORIGINS` | Comma-separated list of additional trusted local API origins |
| `FNZERO_SAFE_ALLOW_SECRET_EXPORT=true` | Allow plaintext private key/mnemonic export from non-desktop local debugging contexts |
| `FNZERO_SAFE_ALLOW_DIRECT_SECRET_INPUT=true` | Allow direct plaintext private key submission from web debugging contexts |
| `FNZERO_MOBILE_DEV_BRIDGE=true` | Use Flutter dev bridge fallback for tests without native libraries |
| `ANDROID_JAVA_HOME` | JDK 17 path for Android package builds |
| `IOS_CODESIGN=true` | Build a signed iOS IPA instead of an unsigned `.app` |
| `IOS_EXPORT_OPTIONS_PLIST` | Export options plist path for signed iOS IPA builds |
| `TAURI_WINDOWS_TARGET` | Override the Tauri Windows target triple |
| `FNZERO_SAFE_FLASHBLOCK_SWQOS_API_TOKEN` | FlashBlock SWQoS token |
| `FNZERO_SAFE_BLOCKRAZOR_SWQOS_API_TOKEN` | BlockRazor SWQoS token |
| `FNZERO_SAFE_ASTRALANE_SWQOS_API_TOKEN` | Astralane SWQoS token |
| `FNZERO_SAFE_SPEEDLANDING_SWQOS_API_TOKEN` | SpeedLanding SWQoS token |

Legacy `SOL_SAFEKEY_*` variables are still accepted as fallbacks for existing local setups.

---

## 8. Security Model

1. **Local-first API**: the desktop API binds to loopback and requires a local API token for protected routes.
2. **Encrypted sensitive requests**: password and secret-bearing JSON requests are encrypted before crossing the local web/API boundary.
3. **Keystore-first storage**: saved wallets store encrypted keystore JSON, not plaintext private keys.
4. **Mobile private storage**: mobile keystore files stay in app private storage; wallet metadata and biometric settings use secure storage.
5. **Biometric confirmation**: mobile signing actions can be gated by platform biometrics; desktop Touch ID uses macOS Keychain access control.
6. **Explicit signing confirmation**: payments, dApp signing, transaction sending, and Squads actions go through a confirmation screen.
7. **Plaintext export controls**: plaintext private key and mnemonic export are intentionally gated and should be used only for migration or local debugging.
8. **No mobile Program workflows**: mobile builds do not expose Program deploy, upgrade, source build, or generic invoke APIs.

Always back up encrypted keystores before depositing funds. Passwords and seed phrases cannot be recovered by FnzeroSafe.

---

## 9. Documentation

- [Desktop UI README](apps/desktop/README.md)
- [Mobile README](apps/mobile/README.md)
- [Mobile Internal Test Checklist](docs/mobile/INTERNAL_TEST_CHECKLIST.md)
- [UI Wallet User Guide](UI_USER_GUIDE.md)
- [Bot Integration Guide](BOT_INTEGRATION.md)
- [CLI User Guide](USER_GUIDE.md)
- [Interactive Tutorial](INTERACTIVE_TUTORIAL.md)
- [Program Deployment Guide](apps/desktop/PROGRAM_DEPLOYMENT.md)

---

## 10. Before Submitting To GitHub

Recommended validation:

```bash
cargo fmt --all -- --check
cargo check --workspace --all-features
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
npm --prefix apps/desktop run lint
npm --prefix apps/desktop run build
cd apps/mobile && flutter analyze
cd apps/mobile && flutter test --dart-define=FNZERO_MOBILE_DEV_BRIDGE=true
```

Package validation when release artifacts are needed:

```bash
make package-android
make package-macos
# Run package-ios on a macOS host with the required iOS platform/runtime installed.
# Run package-windows on a Windows host with MSVC build tools installed.
```

For security-sensitive changes, include the threat model and the validation commands you ran in the pull request.

---

## 11. License

MIT License. See [LICENSE](LICENSE).
