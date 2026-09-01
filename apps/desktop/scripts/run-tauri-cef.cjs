const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TAURI_REPOSITORY = "https://github.com/tauri-apps/tauri.git";
const TAURI_TAG = "tauri-cef-v3.0.0-alpha.25";
const RUST_TOOLCHAIN = "1.95.0";
const installRoot = path.resolve(__dirname, "../../..", "build-cache", "tauri-cef-cli");
const binaryName = process.platform === "win32" ? "cargo-tauri.exe" : "cargo-tauri";
const binaryPath = path.join(installRoot, "bin", binaryName);
const versionMarker = path.join(installRoot, "tauri-cef-version");
const installTarget = path.resolve(__dirname, "../../..", "build-cache", "tauri-cef-cli-build");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN },
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

let installedVersion = "";
try {
  installedVersion = fs.readFileSync(versionMarker, "utf8").trim();
} catch {
  // The pinned CLI has not been installed yet.
}

if (!fs.existsSync(binaryPath) || installedVersion !== TAURI_TAG) {
  console.log(`[tauri-cef] installing ${TAURI_TAG}; this is a one-time build`);
  fs.mkdirSync(installRoot, { recursive: true });
  if (process.platform === "darwin" && process.arch === "arm64") {
    run("rustup", [
      "target",
      "add",
      "x86_64-apple-darwin",
      "--toolchain",
      RUST_TOOLCHAIN,
    ]);
  }
  run("cargo", [
    `+${RUST_TOOLCHAIN}`,
    "install",
    "tauri-cli",
    "--git",
    TAURI_REPOSITORY,
    "--tag",
    TAURI_TAG,
    "--locked",
    "--force",
    "--root",
    installRoot,
  ], {
    env: {
      ...process.env,
      RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN,
      CARGO_TARGET_DIR: installTarget,
    },
  });
  fs.writeFileSync(versionMarker, `${TAURI_TAG}\n`, "utf8");
}

run(binaryPath, process.argv.slice(2));
