<div align="center">
  <h1>FnzSafe - 开源多链钱包</h1>
  <p><strong>面向桌面端和移动端的本地优先、自托管加密钱包，覆盖安全密钥管理、DApp 签名、交易信号、DeFi 研究与 Squads 多签。</strong></p>
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

FnzSafe 是一个开源多链钱包，支持 Solana 和 EVM 兼容网络，并提供实验性的 Bitcoin 与 TRON 账户适配器。Bitcoin 和 TRON 当前只支持账户派生与地址校验，尚不支持转账和广播。项目由 Tauri 桌面钱包、Flutter 移动钱包和 Rust 钱包 SDK/CLI 组成；私钥保存在本地加密 Keystore 中，钱包操作、DApp、加密货币信号和市场研究集中在同一个工作界面内。

## 钱包能力

| 方向 | 已支持能力 |
|---|---|
| 钱包生命周期 | 创建通用助记词钱包，导入助记词/私钥/Keystore，切换和重命名账户，导出加密备份或私钥，修改密码，以及删除本地钱包 |
| Solana 钱包 | SOL、SPL Token、Token-2022 余额和元数据，收款/转账、代币操作、交易记录，以及 mainnet、devnet、testnet 和自定义 RPC |
| EVM 钱包 | 一个派生地址用于全部 EVM 网络，原生资产与 ERC-20 资产、EIP-1559 转账、配置后的 Etherscan V2 交易记录、内置网络和自定义 EVM RPC |
| Bitcoin 与 TRON | 通过统一 Rust、桌面和移动链 API 提供实验性的 BIP84/BIP44 账户派生和地址校验；尚未开放交易构建与广播 |
| DApp 钱包 | 内置 Solana DApp 浏览器、Provider 注入、消息/交易签名、Deep Link、交易预览、自动切换公链，以及可撤销的 DApp 授权 |
| 钱包安全 | Argon2id + AES-256-GCM Keystore、Touch ID/生物识别、TOTP、三重保护钱包（3FA）、自动锁定、敏感日志过滤，日常签名不会把解密后的私钥返回前端 |
| 通用操作 | SOL/SPL/ERC-20 转账，WSOL wrap/unwrap/关闭账户，Durable Nonce、地址簿、Squads v4 多签和 SOL/SPL 支付提案 |
| 开发者工具 | Solana Program 部署/升级/构建、通用函数调用、外部签名请求、部署历史、Rust SDK、CLI、本地 API 与 Bot 集成 |

## 交易、信号与 DeFi

- **按链交易：** Fomo 与 Swap 独立入口，自动填充代币合约，Solana 使用 Jupiter，EVM 链使用对应 DEX，并支持 Pump.fun/PumpSwap 卖出和返现。
- **Twitter 与 Fomo 信号：** 无需 Twitter API 的浏览器采集、Fomo BUY/SELL 实时事件、KOL 过滤、代币解析、翻译、断线重连、后台刷新与 SQLite 缓存。
- **代币情报：** 聚合链、合约、价格、市值、流动性、各周期涨跌、提及次数和 KOL 提及，并可直接打开 Fomo/Swap。
- **DeFi 数据：** 缓存 DefiLlama 链/协议交易量和收入排名，进入页面先显示历史数据，再后台异步刷新。
- **AI 研究：** 基于本地证据检索分析信号和 DeFi，支持配置 AI 提供商，API Key 保存在系统安全存储中。
- **多平台：** macOS、Windows 桌面端，iOS、Android 移动端，以及交互式 Rust CLI。

## 产品截图

以下截图均来自桌面客户端，并加载了本地钱包和研究数据。

| 钱包资产 | Solana 钱包 | 钱包账户 |
|---|---|---|
| ![FnzSafe Solana 与 EVM 多链钱包资产面板](docs/screenshots/zh/01-wallet-assets.png) | ![FnzSafe Solana 钱包 SOL 与 SPL Token 余额](docs/screenshots/zh/02-solana-wallet.png) | ![FnzSafe 加密多账户钱包管理](docs/screenshots/zh/03-wallet-accounts.png) |
| Solana 交易 | DApp 应用商店 | Twitter 信号 |
| ![FnzSafe Solana PumpSwap 交易工具](docs/screenshots/zh/04-solana-trading.png) | ![FnzSafe 内置 Solana DApp 浏览器和应用商店](docs/screenshots/zh/05-dapp-store.png) | ![FnzSafe Twitter 加密货币交易信号](docs/screenshots/zh/06-twitter-signals.png) |
| Fomo 数据流 | DeFi 数据 | 代币行情 |
| ![FnzSafe Fomo BUY 与 SELL 信号数据流](docs/screenshots/zh/07-fomo-stream.png) | ![FnzSafe DefiLlama DeFi 数据分析](docs/screenshots/zh/08-defi-analytics.png) | ![FnzSafe 多链代币行情与 KOL 情报](docs/screenshots/zh/09-token-market.png) |

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

启动前设置 `FNZERO_SAFE_ETHERSCAN_API_KEY`，可在 explorer 与 chain ID 匹配的内置 EVM 网络上启用 Etherscan V2 历史记录。未配置有效 Key 时，对应链描述不会声明 `transactions:history`。

已内置 Arc 主网（5042）和 Arc Testnet（5042002），与 Ethereum 共用账户。原生余额与 Gas 使用 18 位精度的 USDC，ERC-20 USDC 接口不会重复计入资产。Arc 专用历史索引、桥接与兑换尚未接入，详见[支持矩阵](docs/multichain-architecture.md#arc)。

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

macOS 公网发行包必须使用 `Developer ID Application` 证书签名并提交 Apple 公证；`Apple Development` 或 ad-hoc 签名会被 Gatekeeper 拦截。配置 `APPLE_SIGNING_IDENTITY`，并使用 `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`，或 `APPLE_API_KEY`、`APPLE_API_ISSUER`、`APPLE_API_KEY_PATH` 提供公证凭据后，再运行 `make package-macos`。构建命令会在打包前检查配置，并在完成后验证签名、公证票据和 Gatekeeper 状态。仅供本机开发的未签名构建可直接运行 `cd apps/desktop && npm run desktop:build`，不要将其作为下载包发布。

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

- [多链架构与支持矩阵](docs/multichain-architecture.md)
- [移动端开发](apps/mobile/README.md)
- [移动端 EVM 说明](docs/mobile/evm-development.md)
- [AI 插件架构](docs/ai-plugin-architecture.md)
- [示例](examples/README.md)

## 许可证

[MIT](LICENSE)
