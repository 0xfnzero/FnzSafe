const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

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

const args = process.argv.slice(2);
let entitlementDirectory;
try {
  if (process.platform === "darwin") {
    const { macosKeychainOverride } = require("./macos-keychain-config.cjs");
    const override = macosKeychainOverride(args, path.resolve(__dirname, ".."));
    if (override) {
      // The pinned CEF CLI accepts an entitlement file path, not an inline map.
      entitlementDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fnzsafe-entitlements-"));
      const filename = path.join(entitlementDirectory, "entitlements.plist");
      fs.writeFileSync(filename, JSON.stringify(override.bundle.macOS.entitlements), { mode: 0o600 });
      const converted = spawnSync("/usr/bin/plutil", ["-convert", "xml1", filename], { encoding: "utf8" });
      if (converted.error || converted.status !== 0) throw new Error("Unable to generate macOS signing entitlements");
      override.bundle.macOS.entitlements = filename;
      args.push("--config", JSON.stringify(override));
    }
  }
  run(binaryPath, args);
} finally {
  if (entitlementDirectory) fs.rmSync(entitlementDirectory, { recursive: true, force: true });
}
