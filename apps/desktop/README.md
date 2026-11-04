# FnzSafe UI

This directory contains the integrated Next.js interface, local Rust API, and Tauri desktop shell for FnzSafe. The API uses the root workspace crate through a local path dependency; do not clone or vendor another copy of `fnzero-safe` here.

## User guides

- [English UI wallet guide](../../UI_USER_GUIDE.md)
- [中文 UI 钱包指南](../../UI_USER_GUIDE_CN.md)
- [General Solana Program deployment guide](PROGRAM_DEPLOYMENT.md)
- [通用 Solana Program 部署指南](PROGRAM_DEPLOYMENT_CN.md)

## Safe EVM multisig

The desktop sidebar includes Safe EVM multisig creation, proposal exchange, owner signing, execution, and per-wallet account / per-Safe transaction lists for supported mainnets and testnets. See [Safe multisig usage and verification](../../docs/safe-multisig.md).

## Development

Prerequisites: Rust 1.95.0 and Node.js 22–24. The release gate uses Node.js 22.22.2 and npm 10.9.7; the Docker build uses the same Node/Rust versions.

Run commands from the repository root:

```bash
make dev
```

This command stops stale local development processes, starts the local web/API
development stack, and opens the Tauri shell.
Keep the app local; do not expose the API port through a public proxy, tunnel, or
port forward.

中文：从同一个仓库根目录启动 Tauri 桌面端：

```bash
make dev
```

该命令会先停止旧的本地开发进程，再启动本地 Web/API 开发栈并打开 Tauri 桌面壳。请保持本地运行，
不要通过公网代理、隧道或端口转发暴露 API 端口。

Stop all local FnzSafe development processes before packaging (打包前停止全部本地开发进程):

```bash
make stop
```

Development endpoints:

- English UI: `http://127.0.0.1:3840/en/`
- Chinese UI: `http://127.0.0.1:3840/zh/`
- Local API: `http://127.0.0.1:3841/api/health`

Build and check the integrated application with:

```bash
make build-macos
make package-macos
make package-windows
```

`make build-macos` is a local unsigned desktop build. `make package-macos` is a distribution build. It requires a `Developer ID Application`
identity in `APPLE_SIGNING_IDENTITY` plus complete Apple notarization credentials, and
it rejects the output unless codesign, the stapled notarization ticket, and Gatekeeper
all validate. `Apple Development` certificates are for development only and cannot be
used for a public download.

## Layout

```text
apps/desktop/src/           Next.js application and translations
crates/desktop-api/src/     Local Axum API and wallet persistence
apps/desktop/src-tauri/     Tauri desktop shell and secure API bridge
apps/desktop/public/        Token and application assets
apps/desktop/scripts/       Development and security checks
```

The installed macOS app keeps wallet data at `~/Library/Application Support/FnzSafe/fnzero-safe.sqlite3`; browser state uses the stable `dev.sol-safekey.ui` application-data directory. Repository API development defaults to `apps/desktop/data/`, which is ignored by Git. Updating `/Applications/FnzSafe.app` must not remove either application-data directory. Passwords remain in memory only long enough to process each request and are never persisted by the frontend.

## Release language

Write GitHub Release titles, release notes, and annotated Git tag messages in English.

## 安全构建说明

macOS 正式构建只启动应用资源目录内的后端，并验证整个开发者签名应用包及其资源封印（包含后端文件）。未签名的 release 构建可用于编译检查，但不能启动钱包后端；本地开发请使用 `npm run desktop:dev`。

通过 `npm run tauri -- build` / `dev` 构建时，脚本根据签名身份和应用标识生成隔离的 Keychain 权限，开发版与正式版使用不同访问组。新 Touch ID 凭据绑定当前生物信息、仅在本机解锁时可读且不参与云同步。原有凭据在用户主动完成认证后迁移；迁移失败时保留原有凭据并报告错误。发布前还需用实际签名安装包验证 Touch ID 取消、锁屏及生物信息变更行为。

## Updating to 0.6.10

Quit FnzSafe, preserve a private backup of its application-support directories, and replace only the application bundle. The application identifier and wallet database location remain unchanged. Existing encrypted wallet records are retained; no password reset, automatic re-encryption or wallet import is required. Touch ID may require authentication or reconfiguration after the security update; the existing wallet password remains the recovery path.

The local-wallet AI sell tool now only prepares a proposal. AI receives a separate session-status read capability, and the backend rejects that capability for signing, exports, unlocks and writes. Review and execute trades manually in the wallet trading interface.

### Local macOS validation without a provisioning profile

An Apple Development certificate alone cannot authorize protected Keychain entitlements. For local validation only, set `FNZSAFE_LOCAL_VALIDATION=1` together with `APPLE_SIGNING_IDENTITY="Apple Development: ..."` when building or bundling. This omits protected Keychain entitlements: use the existing wallet password; Touch ID is unavailable and protected Keychain operations fail closed. It does not weaken the wallet encryption or provide a legacy Keychain fallback. Do not publish this build; public packages require Developer ID signing and notarization.
