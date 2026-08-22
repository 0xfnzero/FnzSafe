# FnzSafe UI

This directory contains the integrated Next.js interface, local Rust API, and Tauri desktop shell for FnzSafe. The API uses the root workspace crate through a local path dependency; do not clone or vendor another copy of `fnzero-safe` here.

## User guides

- [English UI wallet guide](../../UI_USER_GUIDE.md)
- [中文 UI 钱包指南](../../UI_USER_GUIDE_CN.md)
- [General Solana Program deployment guide](PROGRAM_DEPLOYMENT.md)
- [通用 Solana Program 部署指南](PROGRAM_DEPLOYMENT_CN.md)

## Development

Prerequisites: Rust 1.89 or newer for workspace/API builds, and Node.js 20 or 22 and newer (Node.js 21 is unsupported). The release gate uses Node.js 20.19.5 and npm 10.8.2 exactly. The standalone Tauri crate declares its independently audited Rust 1.88 minimum, but repository-wide commands require Rust 1.89.

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

Development endpoints:

- English UI: `http://127.0.0.1:3840/en/`
- Chinese UI: `http://127.0.0.1:3840/zh/`
- Local API: `http://127.0.0.1:3841/api/health`

Build and check the integrated application with:

```bash
make package-macos
make package-windows
```

## Layout

```text
apps/desktop/src/           Next.js application and translations
crates/desktop-api/src/     Local Axum API and wallet persistence
apps/desktop/src-tauri/     Tauri desktop shell and secure API bridge
apps/desktop/public/        Token and application assets
apps/desktop/scripts/       Development and security checks
```

Wallet data is stored locally in `apps/desktop/data/` by default and is ignored by Git. Passwords remain in memory only long enough to process each request and are never persisted by the frontend.
