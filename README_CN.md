<div align="center">
  <h1>FnzSafe</h1>
  <p><strong>本地优先的 Solana 与 EVM 钱包工作区，覆盖资产、DApp、交易、信号、DeFi 研究与多签。</strong></p>
  <p>
    <a href="README.md">English</a> ·
    <a href="https://github.com/0xfnzero/FnzSafe/releases/latest">下载</a> ·
    <a href="https://fnzero.dev/">官网</a> ·
    <a href="https://t.me/fnzero_group">Telegram</a> ·
    <a href="https://discord.gg/ckf5UHxz">Discord</a>
  </p>
  <p>
    <a href="https://crates.io/crates/fnzero-safe-core"><img src="https://img.shields.io/crates/v/fnzero-safe-core.svg" alt="Crates.io"></a>
    <a href="https://docs.rs/fnzero-safe-core"><img src="https://img.shields.io/docs.rs/fnzero-safe-core/badge.svg" alt="文档"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT 许可证"></a>
  </p>
</div>

FnzSafe 由 Tauri 桌面端、Flutter 移动端和 Rust 核心库/CLI 组成。钱包密钥保存在本地加密 Keystore 中，桌面端把钱包操作、DApp 与市场研究集中在一个工作界面内。

## 主要功能

- **钱包：** 创建或导入 Solana/EVM 钱包，管理多个账户，查看 SOL、SPL、Token-2022、EVM 原生资产和 ERC-20 资产，支持收款与转账。
- **安全：** 密码加密 Keystore、Touch ID/生物识别、交易预览、本地 API 防护与敏感日志过滤。
- **交易与 DApp：** 内置 Solana DApp 浏览器、按链切换钱包、Jupiter/Fomo/DEX 跳转、Pump.fun 与 PumpSwap 工具，以及交易签名前确认。
- **信号：** 持续刷新 Twitter 与 Fomo 数据流，支持 BUY/SELL 过滤、代币/KOL 视图、翻译、本地缓存与断线重连。
- **DeFi 研究：** 缓存 DefiLlama 链和协议的交易量/收入排名，并支持本地证据驱动的 AI 研究。
- **高级工作流：** Squads v4 多签、SOL/SPL 提案、WSOL 与 Nonce 工具、Program 部署/升级、Rust SDK、CLI 与 Bot 集成。
- **多平台：** macOS、Windows 桌面端，iOS、Android 移动端，以及交互式 Rust CLI。

## 产品截图

以下截图均来自桌面客户端，并加载了本地钱包和研究数据。

| 钱包资产 | Solana 钱包 | 钱包账户 |
|---|---|---|
| ![钱包资产](docs/screenshots/zh/01-wallet-assets.png) | ![Solana 钱包](docs/screenshots/zh/02-solana-wallet.png) | ![钱包账户](docs/screenshots/zh/03-wallet-accounts.png) |
| Solana 交易 | DApp 应用商店 | Twitter 信号 |
| ![Solana 交易](docs/screenshots/zh/04-solana-trading.png) | ![DApp 应用商店](docs/screenshots/zh/05-dapp-store.png) | ![Twitter 信号](docs/screenshots/zh/06-twitter-signals.png) |
| Fomo 数据流 | DeFi 数据 | 代币行情 |
| ![Fomo 数据流](docs/screenshots/zh/07-fomo-stream.png) | ![DeFi 数据](docs/screenshots/zh/08-defi-analytics.png) | ![代币行情](docs/screenshots/zh/09-token-market.png) |

## 环境要求

- Rust 1.89+
- Node.js 22-24、npm 10+
- 构建 macOS/iOS 需要 macOS；构建 Windows 安装包需要 Windows 与 MSVC build tools
- 仅移动端开发需要 Flutter 3.24+、Xcode 或 Android SDK/NDK/JDK 17

## 运行

桌面端：

```bash
npm --prefix apps/desktop install
make dev
```

`make dev` 会启动 Tauri 客户端、`127.0.0.1:3840` 上的 Next.js UI，以及 `127.0.0.1:3841` 上的本地 API。使用 `make stop` 停止全部本地开发进程。

移动端：

```bash
cd apps/mobile
./tool/bootstrap_mobile.sh
flutter pub get
./tool/generate_bridge.sh
flutter run -d ios       # 或 Android 设备 ID
```

CLI：

```bash
cargo run -p fnzero-safe-core --features full -- start
```

## 打包

产物会复制到 `release/<platform>/`。

```bash
make package-macos
make package-windows
make package-ios
make package-android
```

`make package` 会构建当前主机支持的全部平台。签名 iOS 包需要 Apple Developer 配置；Android 正式签名需要 `apps/mobile/android/key.properties`；Windows 安装包建议在 Windows 上构建。

## 验证

```bash
cargo fmt --all -- --check
cargo test --workspace
npm --prefix apps/desktop run test:unit
npm --prefix apps/desktop run lint
```

## 安全说明

FnzSafe 采用本地优先架构，但钱包软件仍有真实资金风险。请备份加密 Keystore，逐项核对地址和交易预览，切勿通过隧道或公共代理暴露桌面 API 端口。行情和信号数据仅供参考，不构成投资建议。

## 文档

- [移动端开发](apps/mobile/README.md)
- [移动端 EVM 说明](docs/mobile/evm-development.md)
- [AI 插件架构](docs/ai-plugin-architecture.md)
- [示例](examples/README.md)

## 许可证

[MIT](LICENSE)
