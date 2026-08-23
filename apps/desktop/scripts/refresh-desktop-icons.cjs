const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const tauriRoot = path.join(repoRoot, "src-tauri");
const sourceIcon = path.join(tauriRoot, "icons", "icon.icns");
const buildScript = path.join(tauriRoot, "build.rs");
const debugApp = path.join(tauriRoot, "target", "debug", "FnzSafe");

const existingBundleIcons = [
  path.join(
    tauriRoot,
    "target",
    "release",
    "bundle",
    "macos",
    "FnzSafe.app",
    "Contents",
    "Resources",
    "icon.icns",
  ),
  path.join(tauriRoot, "target", "release", "bundle", "dmg", "icon.icns"),
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyIfDifferent(source, target) {
  if (!fs.existsSync(source) || !fs.existsSync(target)) {
    return false;
  }
  if (sha256(source) === sha256(target)) {
    return false;
  }
  fs.copyFileSync(source, target);
  return true;
}

function touch(file) {
  const now = new Date();
  fs.utimesSync(file, now, now);
}

let synced = 0;
for (const bundleIcon of existingBundleIcons) {
  if (copyIfDifferent(sourceIcon, bundleIcon)) {
    synced += 1;
  }
}

if (fs.existsSync(sourceIcon) && fs.existsSync(debugApp) && fs.existsSync(buildScript)) {
  const iconMtime = fs.statSync(sourceIcon).mtimeMs;
  const appMtime = fs.statSync(debugApp).mtimeMs;
  if (iconMtime > appMtime) {
    touch(buildScript);
    console.log("[desktop-icons] icon changed; marked Tauri shell for rebuild");
  }
}

if (synced > 0) {
  console.log(`[desktop-icons] synced ${synced} existing bundle icon file(s)`);
}
