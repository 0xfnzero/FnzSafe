<div align="center">
  <h1>FnzSafe</h1>
  <p><strong>A local-first Solana and EVM wallet workspace for assets, dApps, trading, signals, DeFi research, and multisig.</strong></p>
  <p>
    <a href="README_CN.md">中文</a> ·
    <a href="https://github.com/0xfnzero/FnzSafe/releases/latest">Download</a> ·
    <a href="https://fnzero.dev/">Website</a> ·
    <a href="https://t.me/fnzero_group">Telegram</a> ·
    <a href="https://discord.gg/ckf5UHxz">Discord</a>
  </p>
  <p>
    <a href="https://crates.io/crates/fnzero-safe-core"><img src="https://img.shields.io/crates/v/fnzero-safe-core.svg" alt="Crates.io"></a>
    <a href="https://docs.rs/fnzero-safe-core"><img src="https://img.shields.io/docs.rs/fnzero-safe-core/badge.svg" alt="Documentation"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  </p>
</div>

FnzSafe combines a Tauri desktop app, a Flutter mobile app, and a Rust core/CLI. Wallet secrets remain in encrypted local keystores, while the desktop client brings wallet operations and market research into one working surface.

## Features

- **Wallets:** create or import Solana/EVM wallets, manage multiple accounts, inspect SOL/SPL/Token-2022 and native/ERC-20 assets, and send or receive funds.
- **Security:** password-encrypted keystores, Touch ID/biometric confirmation, transaction previews, local API protection, and sensitive-log filtering.
- **Trading and dApps:** built-in Solana dApp browser, wallet-aware chain switching, Jupiter/Fomo/DEX links, Pump.fun and PumpSwap tools, and user-confirmed signing.
- **Signals:** continuously refreshed Twitter and Fomo feeds, BUY/SELL filters, token and KOL views, translation, local caching, and reconnect controls.
- **DeFi research:** cached DefiLlama chain/protocol volume and revenue rankings plus local AI-assisted research.
- **Advanced workflows:** Squads v4 multisig, SOL/SPL proposals, WSOL and nonce tools, Program deployment/upgrades, Rust SDK, CLI, and bot integration.
- **Platforms:** macOS and Windows desktop packages, iOS and Android apps, and an interactive Rust CLI.

## Screenshots

All screenshots below are from the desktop client with locally loaded wallet and research data.

| Wallet assets | Solana wallet | Wallet accounts |
|---|---|---|
| ![Wallet assets](docs/screenshots/en/01-wallet-assets.png) | ![Solana wallet](docs/screenshots/en/02-solana-wallet.png) | ![Wallet accounts](docs/screenshots/en/03-wallet-accounts.png) |
| Solana trading | DApp store | Twitter signals |
| ![Solana trading](docs/screenshots/en/04-solana-trading.png) | ![DApp store](docs/screenshots/en/05-dapp-store.png) | ![Twitter signals](docs/screenshots/en/06-twitter-signals.png) |
| Fomo stream | DeFi analytics | Token market |
| ![Fomo stream](docs/screenshots/en/07-fomo-stream.png) | ![DeFi analytics](docs/screenshots/en/08-defi-analytics.png) | ![Token market](docs/screenshots/en/09-token-market.png) |

## Requirements

- Rust 1.89+
- Node.js 22-24 and npm 10+
- macOS for macOS/iOS builds; Windows with MSVC build tools for Windows packages
- Flutter 3.24+, Xcode, or Android SDK/NDK/JDK 17 only when working on mobile

## Run

Desktop:

```bash
npm --prefix apps/desktop install
make dev
```

`make dev` starts the Tauri app, the Next.js UI on `127.0.0.1:3840`, and the local API on `127.0.0.1:3841`. Stop all local development processes with `make stop`.

Mobile:

```bash
cd apps/mobile
./tool/bootstrap_mobile.sh
flutter pub get
./tool/generate_bridge.sh
flutter run -d ios       # or an Android device ID
```

CLI:

```bash
cargo run -p fnzero-safe-core --features full -- start
```

## Package

Artifacts are copied into `release/<platform>/`.

```bash
make package-macos
make package-windows
make package-ios
make package-android
```

Use `make package` to build every platform supported by the current host. Signed iOS packages require an Apple developer configuration; Android release signing requires `apps/mobile/android/key.properties`; Windows packages should be built on Windows.

## Verify

```bash
cargo fmt --all -- --check
cargo test --workspace
npm --prefix apps/desktop run test:unit
npm --prefix apps/desktop run lint
```

## Security

FnzSafe is local-first, but wallet software still carries real risk. Back up encrypted keystores, verify addresses and transaction previews, and never expose the desktop API port through a tunnel or public proxy. Market and signal data is informational, not financial advice.

## Documentation

- [Mobile development](apps/mobile/README.md)
- [Mobile EVM notes](docs/mobile/evm-development.md)
- [AI plugin architecture](docs/ai-plugin-architecture.md)
- [Examples](examples/README.md)

## License

[MIT](LICENSE)
