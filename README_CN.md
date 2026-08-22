<div align="center">
    <h1>FnzeroSafe</h1>
    <h3><em>本地优先的 Solana 与 EVM 钱包、安全 Keystore、桌面端与 iOS/Android 移动端应用</em></h3>
</div>

<p align="center">
    <strong>FnzeroSafe 是一个开源 Solana 与 EVM 钱包安全工作区，覆盖加密 Keystore、桌面端签名、移动端钱包、dApp 签名、Pump 交易、Squads 多签、Bot 集成，以及仅桌面端开放的高级 Program 工作流。</strong>
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
    <a href="https://fnzero.dev/">官网</a> |
    <a href="https://t.me/fnzero_group">Telegram</a> |
    <a href="https://discord.gg/ckf5UHxz">Discord</a>
</p>

---

## 文档大纲

1. [项目概览](#1-项目概览)
   1. [FnzeroSafe 适合什么场景](#11-fnzerosafe-适合什么场景)
   2. [产品形态](#12-产品形态)
   3. [能力矩阵](#13-能力矩阵)
   4. [平台矩阵](#14-平台矩阵)
2. [仓库结构](#2-仓库结构)
3. [开发环境](#3-开发环境)
   1. [必要工具链](#31-必要工具链)
   2. [一次性初始化](#32-一次性初始化)
   3. [构建机说明](#33-构建机说明)
4. [开发环境运行](#4-开发环境运行)
   1. [桌面端](#41-桌面端)
   2. [iOS 端](#42-ios-端)
   3. [Android 端](#43-android-端)
   4. [CLI](#44-cli)
5. [打包发布](#5-打包发布)
   1. [Release 目录](#51-release-目录)
   2. [macOS 桌面端](#52-macos-桌面端)
   3. [Windows 桌面端](#53-windows-桌面端)
   4. [iOS](#54-ios)
   5. [Android](#55-android)
   6. [全部平台](#56-全部平台)
6. [命令速查](#6-命令速查)
7. [配置项](#7-配置项)
8. [安全模型](#8-安全模型)
9. [文档索引](#9-文档索引)
10. [提交到 GitHub 前](#10-提交到-github-前)
11. [许可证](#11-许可证)

---

## 1. 项目概览

### 1.1 FnzeroSafe 适合什么场景

FnzeroSafe 是一个本地优先的 Solana 与 EVM 钱包和密钥管理工作区。仓库内同时包含 Rust 核心库、交互式 CLI、本地桌面 API、Next.js 前端、Tauri 桌面壳，以及面向 iOS/Android 的 Flutter 移动端应用。

| 方向 | 覆盖范围 |
|---|---|
| 钱包 | 创建钱包、导入 keystore/私钥/助记词、解锁钱包、导出加密备份 |
| 安全 | 密码 Keystore、本地 API 敏感请求加密、本地 API token、TOTP、生物识别确认、敏感日志过滤 |
| 资产 | SOL 余额、SPL Token 账户、Token-2022 账户、mint 元数据、交易历史 |
| 转账 | SOL 转账、SPL 转账、WSOL wrap/unwrap/close ATA |
| dApp | 内置 WebView、Solana provider 注入、消息/交易预览、用户确认签名 |
| Squads | Squads v4 多签创建、查看、proposal、approve/reject/execute、SOL/SPL 支付 proposal |
| 交易 | Pump.fun 与 PumpSwap 卖出流程、返现查看与领取、SWQoS token 配置 |
| Program | 仅桌面端开放 Program 部署、升级、源码构建、权限与部署管理 |
| 自动化 | Rust SDK、CLI helper、本地 API、Bot 集成示例 |
| EVM | 内置 EVM 链注册表、自定义 RPC 模型、secp256k1 钱包、ERC-20 资产、EIP-1559 转账、EIP-712/dApp 签名 |

### 1.2 产品形态

| 形态 | 路径 | 技术栈 | 主要用途 |
|---|---|---|---|
| 桌面端应用 | `apps/desktop` | Next.js + Tauri + Rust API | 完整本地钱包控制台、dApp 签名、Pump、Squads、Program 工作流 |
| 移动端应用 | `apps/mobile` | Flutter + `flutter_rust_bridge` + Rust core | iOS/Android 钱包、资产、转账、dApp 签名、Pump、Squads |
| Rust core / CLI | `crates/core` | Rust | Keystore、CLI、SDK 集成和自动化 |
| 共享服务层 | `crates/app-services` | Rust | 桌面端与移动端复用的钱包/资产/转账/dApp/Squads 业务逻辑 |
| 移动端 bridge | `crates/mobile-bridge` | Rust FFI | Flutter 调用的 FRB-friendly API |

### 1.3 能力矩阵

| 能力 | 桌面端 | iOS | Android | 说明 |
|---|---:|---:|---:|---|
| 钱包创建/导入/解锁/导出 | 支持 | 支持 | 支持 | Secret 保存在加密 Keystore 中 |
| SOL/SPL 资产和交易历史 | 支持 | 支持 | 支持 | 使用 Solana RPC |
| SOL/SPL/WSOL 转账 | 支持 | 支持 | 支持 | 必须用户确认 |
| EVM 钱包和自定义 RPC 链 | 支持 | 支持 | 支持 | 内置常见链，也支持用户提供 EVM RPC |
| EVM native/ERC-20 资产 | 支持 | 支持 | 支持 | native 余额、ERC-20 元数据、token 余额 |
| EVM native/ERC-20 转账 | 支持 | 支持 | 支持 | 优先 EIP-1559 type-2，必要时回退 legacy gas |
| EVM dApp 签名/发送 | 支持 | 支持 | 支持 | `personal_sign`、`eth_signTypedData_v4`、`eth_signTransaction`、`eth_sendTransaction` |
| dApp 消息签名 | 支持 | 支持 | 支持 | 移动端通过 WebView/provider 流程 |
| dApp 交易签名/发送 | 支持 | 支持 | 支持 | 必须用户确认 |
| Squads 多签 | 支持 | 支持 | 支持 | 创建、proposal、approve/reject/execute |
| PumpFun/PumpSwap | 支持 | 移动端部分集成 | 移动端部分集成 | 移动端 submit 流程持续完善 |
| Program deploy | 支持 | 不支持 | 不支持 | 设计上仅桌面端开放 |
| Program upgrade | 支持 | 不支持 | 不支持 | 设计上仅桌面端开放 |
| Program source build | 支持 | 不支持 | 不支持 | 设计上仅桌面端开放 |
| 通用 Program invoke | 支持 | 不支持 | 不支持 | 设计上仅桌面端开放 |

### 1.4 平台矩阵

| 平台 | 状态 | 主要命令 | 输出 |
|---|---|---|---|
| 桌面端开发 | 支持 | `make dev` | Tauri 应用、`127.0.0.1:3840` 上的 Next.js、`127.0.0.1:3841` 上的 API |
| macOS 桌面端包 | macOS 构建机支持 | `make package-macos` | `release/macos/*.dmg` 和 `.app` |
| Windows 桌面端包 | Windows runner 支持 | `make package-windows` | `release/windows/*.msi` 和/或 `.exe` |
| iOS 应用包 | 需要 Xcode iOS platform/signing | `make package-ios` | `release/ios/*.app` 或 `.ipa` |
| Android 应用包 | 支持 | `make package-android` | `release/android/*.apk` 和 `.aab` |
| CLI | 支持 | `cargo run -p fnzero-safe-core --features full -- start` | 交互式终端钱包工具 |

---

## 2. 仓库结构

```text
/
├─ Cargo.toml
├─ Makefile
├─ crates/
│  ├─ core/                      # Rust SDK 与 CLI 二进制：fnzero-safe
│  ├─ evm-services/              # 通用 EVM 链、钱包、资产、fee、交易和 dApp 服务
│  ├─ app-services/              # 共享钱包/资产/转账/dApp/Squads 服务
│  ├─ desktop-api/               # 桌面端/Web 使用的本地 Axum API
│  └─ mobile-bridge/             # flutter_rust_bridge FFI 层
├─ apps/
│  ├─ desktop/                   # Next.js UI 与 Tauri 桌面壳
│  └─ mobile/                    # Flutter iOS/Android 应用
├─ packages/
│  └─ shared-contracts/          # 共享 API 契约和接口说明
├─ examples/                     # Bot 与 Keystore 示例
├─ docs/                         # 内测和开发文档
└─ release/                      # 打包产物目录，已被 Git 忽略
```

对外产品名统一是 **FnzeroSafe**。`fnzero-safe-core`、`fnzero-safe-desktop-api`、`fnzero-safe-mobile-bridge` 这类名称只是 Cargo workspace 内部包名，用来保证各 crate 名称唯一。

---

## 3. 开发环境

### 3.1 必要工具链

| 工具 | 推荐版本 | 用途 |
|---|---|---|
| Rust | 1.89+ | Workspace、CLI、桌面 API、移动端 bridge |
| Node.js | 20 或 22+ | 桌面端 Web 应用 |
| npm | 10+ | 桌面端依赖和脚本 |
| Flutter / Dart | Flutter 3.24+ | iOS 与 Android 应用 |
| Xcode | 当前稳定版 | macOS 桌面端包、iOS 模拟器/真机/archive |
| Android Studio / SDK / NDK | 当前稳定版 | Android 构建和模拟器 |
| JDK | 17 | Android Gradle 构建 |
| `cargo-ndk` | 最新版 | Android Rust bridge 动态库 |
| `flutter_rust_bridge_codegen` | FRB 2.x | 重新生成 Dart/Rust bridge 代码 |

### 3.2 一次性初始化

```bash
rustup update
npm --version
flutter doctor -v
cargo install cargo-ndk
cargo install flutter_rust_bridge_codegen
npm --prefix apps/desktop install
cd apps/mobile && flutter pub get
```

修改 `crates/mobile-bridge/src/api.rs` 后，需要重新生成移动端 bridge：

```bash
cd apps/mobile
./tool/generate_bridge.sh
```

### 3.3 构建机说明

| 构建机 | 说明 |
|---|---|
| macOS | macOS 桌面端包和 iOS 构建需要 macOS。请在 Xcode > Settings > Components 安装匹配的 iOS platform/runtime。 |
| Windows | 推荐在 Windows runner 上运行 `make package-windows`，并安装 MSVC target 和 Visual Studio build tools。 |
| Android | 推荐 JDK 17。可以用 `ANDROID_JAVA_HOME=/path/to/jdk17 make package-android` 覆盖自动检测。 |
| iOS 签名 | `make package-ios` 可做无签名 `.app` 构建；签名 IPA/TestFlight 需要 Apple developer team、profile 和 export options。 |

---

## 4. 开发环境运行

### 4.1 桌面端

在仓库根目录运行：

```bash
npm --prefix apps/desktop install
make dev
```

`make dev` 会先停止旧的本地开发进程，然后启动：

| 服务 | 地址 |
|---|---|
| 英文 UI | `http://127.0.0.1:3840/en/` |
| 中文 UI | `http://127.0.0.1:3840/zh/` |
| 本地 API 健康检查 | `http://127.0.0.1:3841/api/health` |

本地 API 只应该绑定 loopback 使用。不要通过公网代理、隧道或端口转发暴露 `3841`。

### 4.2 iOS 端

```bash
cd apps/mobile
./tool/bootstrap_mobile.sh
flutter pub get
./tool/generate_bridge.sh
./tool/build_ios_native.sh
flutter run -d ios
```

iOS 要求：

1. 使用 `xcode-select` 选择正确的 Xcode command line tools。
2. 在 Xcode Components 中安装匹配的 iOS platform/runtime。
3. iOS deployment target 是 15.0。
4. 真机和 TestFlight 需要常规 Xcode 签名配置。

### 4.3 Android 端

```bash
cd apps/mobile
./tool/bootstrap_mobile.sh
flutter pub get
./tool/generate_bridge.sh
./tool/build_android_native.sh
flutter run -d android
```

Android 说明：

1. Android application id 是 `dev.fnzero.safe`。
2. Android `minSdk` 是 26。
3. Rust bridge `.so` 会生成 `arm64-v8a`、`armeabi-v7a`、`x86`、`x86_64` 四种 ABI。
4. Gradle 推荐使用 JDK 17。

### 4.4 CLI

```bash
cargo run -p fnzero-safe-core --features full -- start
```

从源码安装本地 CLI：

```bash
cargo install --path crates/core --features full
fnzero-safe start
```

---

## 5. 打包发布

### 5.1 Release 目录

所有打包命令都会把产物复制到根目录 `release/`：

```text
release/
├─ android/
│  ├─ app-release.apk
│  └─ app-release.aab
├─ ios/
│  └─ *.app 或 *.ipa
├─ macos/
│  ├─ FnzeroSafe.app
│  └─ FnzeroSafe_*.dmg
└─ windows/
   └─ *.msi 和/或 *.exe
```

`release/` 已被 Git 忽略。

### 5.2 macOS 桌面端

```bash
make package-macos
```

该命令会执行桌面端生产构建，并把 `.dmg` 和 `.app` 复制到 `release/macos/`。

### 5.3 Windows 桌面端

```bash
make package-windows
```

该命令会构建 Tauri Windows 安装包，并把 `.msi` 和/或 `.exe` 复制到 `release/windows/`。

推荐构建环境：Windows runner，并安装 Rust、Node.js、npm 和 Microsoft Visual Studio build tools。从 macOS 交叉构建 Windows 安装包需要额外工具链配置。

需要覆盖目标平台时：

```bash
TAURI_WINDOWS_TARGET=x86_64-pc-windows-msvc make package-windows
```

### 5.4 iOS

无签名本地 `.app` 构建：

```bash
make package-ios
```

签名 IPA 构建：

```bash
IOS_CODESIGN=true IOS_EXPORT_OPTIONS_PLIST=/path/to/ExportOptions.plist make package-ios
```

该命令会先构建 Rust iOS `FnzeroSafeMobileBridge.xcframework`，再执行 Flutter iOS 打包，并把产物复制到 `release/ios/`。

### 5.5 Android

```bash
make package-android
```

如果 JDK 17 没有被自动发现：

```bash
ANDROID_JAVA_HOME=/path/to/jdk17 make package-android
```

Android release signing：

```bash
cp apps/mobile/android/key.properties.example apps/mobile/android/key.properties
# 编辑 key.properties，让 storeFile、storePassword、keyAlias、keyPassword 指向你的 upload keystore。
make package-android
```

该命令会构建 Rust Android native libraries、release APK 和 release AAB，并把产物复制到 `release/android/`。

### 5.6 全部平台

```bash
make package
```

该命令会依次运行 Android、iOS、macOS、Windows 打包目标。CI 中更推荐每个平台放到对应原生 runner 上分别构建。

---

## 6. 命令速查

| 命令 | 说明 |
|---|---|
| `make dev` | 启动桌面端开发环境；会先停止旧的本地应用/API 进程 |
| `make package-macos` | 构建 macOS 桌面端包到 `release/macos/` |
| `make package-windows` | 构建 Windows 桌面端包到 `release/windows/` |
| `make package-ios` | 构建 iOS `.app` 或签名 `.ipa` 到 `release/ios/` |
| `make package-android` | 构建 Android APK/AAB 到 `release/android/` |
| `make package` | 构建全部平台包 |
| `cargo fmt --all -- --check` | 检查 Rust 格式 |
| `cargo check --workspace --all-features` | 检查完整 Rust workspace |
| `cargo test --workspace` | 运行 Rust 测试 |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 运行严格 Rust lint |
| `npm --prefix apps/desktop run lint` | 运行桌面端 lint 和敏感输入检查 |
| `npm --prefix apps/desktop run build` | 构建 Next.js 静态前端 |
| `cd apps/mobile && flutter analyze` | 分析 Flutter 应用 |
| `cd apps/mobile && flutter test --dart-define=FNZERO_MOBILE_DEV_BRIDGE=true` | 使用 dev bridge fallback 运行 Flutter 测试 |

---

## 7. 配置项

| 变量 | 用途 |
|---|---|
| `FNZERO_SAFE_API_TOKEN` | 桌面/Web 开发使用的固定本地 API token |
| `FNZERO_SAFE_DB_PATH` | 覆盖钱包数据库路径。`make dev` 会优先沿用已有的 `apps/desktop/data/sol-safekey.sqlite3` 旧开发钱包库，否则使用 `apps/desktop/data/fnzero-safe.sqlite3`。 |
| `FNZERO_SAFE_ALLOWED_ORIGINS` | 额外允许访问本地 API 的 origin，多个用逗号分隔 |
| `FNZERO_SAFE_ALLOW_SECRET_EXPORT=true` | 允许非桌面本机调试上下文导出明文私钥/助记词 |
| `FNZERO_SAFE_ALLOW_DIRECT_SECRET_INPUT=true` | 允许 Web 调试上下文直接提交明文私钥 |
| `FNZERO_MOBILE_DEV_BRIDGE=true` | 无 native library 测试时使用 Flutter dev bridge fallback |
| `ANDROID_JAVA_HOME` | Android 打包使用的 JDK 17 路径 |
| `IOS_CODESIGN=true` | 构建签名 iOS IPA，而不是无签名 `.app` |
| `IOS_EXPORT_OPTIONS_PLIST` | 签名 iOS IPA 使用的 export options plist |
| `TAURI_WINDOWS_TARGET` | 覆盖 Tauri Windows target triple |
| `FNZERO_SAFE_FLASHBLOCK_SWQOS_API_TOKEN` | FlashBlock SWQoS token |
| `FNZERO_SAFE_BLOCKRAZOR_SWQOS_API_TOKEN` | BlockRazor SWQoS token |
| `FNZERO_SAFE_ASTRALANE_SWQOS_API_TOKEN` | Astralane SWQoS token |
| `FNZERO_SAFE_SPEEDLANDING_SWQOS_API_TOKEN` | SpeedLanding SWQoS token |

旧的 `SOL_SAFEKEY_*` 环境变量仍作为 fallback 保留，用于兼容已经存在的本机配置。

---

## 8. 安全模型

1. **本地优先 API**：桌面端 API 绑定 loopback，受保护路由需要本地 API token。
2. **敏感请求加密**：包含密码和 secret 的 JSON 请求在跨本地 Web/API 边界前会先加密。
3. **Keystore 优先**：已保存钱包存储的是加密 keystore JSON，不保存明文私钥。
4. **移动端私有存储**：移动端 keystore 文件保存在 App 私有目录；钱包元数据和生物识别设置使用 secure storage。
5. **生物识别确认**：移动端签名动作可以由系统生物识别二次确认保护；桌面端 Touch ID 使用 macOS Keychain 访问控制。
6. **显式签名确认**：转账、dApp 签名、交易发送、Squads 操作都必须进入确认页。
7. **明文导出控制**：明文私钥和助记词导出有意加限制，只应临时用于迁移或本机调试。
8. **移动端不开放 Program 工作流**：移动端不暴露 Program deploy、upgrade、source build 或 generic invoke API。

存入资产前请先备份加密 Keystore。密码、私钥、助记词无法由 FnzeroSafe 恢复。

---

## 9. 文档索引

- [桌面端 README](apps/desktop/README.md)
- [移动端 README](apps/mobile/README.md)
- [移动端内测清单](docs/mobile/INTERNAL_TEST_CHECKLIST.md)
- [UI 钱包用户指南](UI_USER_GUIDE_CN.md)
- [Bot 集成指南](BOT_INTEGRATION_CN.md)
- [CLI 使用手册](USER_GUIDE_CN.md)
- [交互式教程](INTERACTIVE_TUTORIAL_CN.md)
- [Program 部署指南](apps/desktop/PROGRAM_DEPLOYMENT_CN.md)

---

## 10. 提交到 GitHub 前

推荐验证：

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

需要提交发布产物前，可额外验证打包：

```bash
make package-android
make package-macos
# package-ios 需要在已安装对应 iOS platform/runtime 的 macOS 上运行。
# package-windows 推荐在安装 MSVC build tools 的 Windows 构建机上运行。
```

涉及安全敏感逻辑的改动，请在 PR 中写清楚威胁模型和已经执行的验证命令。

---

## 11. 许可证

MIT License。详见 [LICENSE](LICENSE)。
