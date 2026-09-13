const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(root, "../..");
const isWindows = process.platform === "win32";
const desktopApiPidFileName = "desktop-api.pid";
const desktopWebPidFileName = "desktop-web.pid";
const cleanupScript = path.join(__dirname, "kill-dev-processes.cjs");
let shuttingDown = false;
const children = [];

function sharedApiToken() {
  const existing = String(process.env.FNZERO_SAFE_API_TOKEN || process.env.SOL_SAFEKEY_API_TOKEN || "").trim();
  return existing || randomBytes(32).toString("base64url");
}

function desktopDatabasePath() {
  const existing = String(process.env.FNZERO_SAFE_DB_PATH || process.env.SOL_SAFEKEY_DB_PATH || "").trim();
  if (existing) return existing;

  const appSupportDir =
    process.platform === "darwin"
      ? path.join(process.env.HOME || root, "Library", "Application Support", "FnzSafe")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA || root, "FnzSafe")
        : path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || root, ".local", "share"), "FnzSafe");
  const nextPath = path.join(appSupportDir, "fnzero-safe.sqlite3");
  if (fs.existsSync(nextPath)) return nextPath;

  const candidateSources = [
    path.join(appSupportDir, "sol-safekey.sqlite3"),
    path.join(root, "data", "fnzero-safe.sqlite3"),
    path.join(root, "data", "sol-safekey.sqlite3"),
    path.join(workspaceRoot, "crates", "desktop-api", "data", "fnzero-safe.sqlite3"),
    path.join(workspaceRoot, "crates", "desktop-api", "data", "sol-safekey.sqlite3"),
    path.join(workspaceRoot, "data", "fnzero-safe.sqlite3"),
    path.join(workspaceRoot, "data", "sol-safekey.sqlite3"),
  ];
  const source = candidateSources.find((candidate) => {
    try {
      return fs.statSync(candidate).size > 0;
    } catch {
      return false;
    }
  });
  if (source) {
    fs.mkdirSync(path.dirname(nextPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, nextPath);
    fs.chmodSync(nextPath, 0o600);
    console.log(`[dev:stack] migrated wallet database from ${source} to ${nextPath}`);
  }

  return nextPath;
}

function appSupportDir() {
  const dbPath = String(process.env.FNZERO_SAFE_DB_PATH || process.env.SOL_SAFEKEY_DB_PATH || "").trim();
  if (dbPath) return path.dirname(dbPath);
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || root, "Library", "Application Support", "FnzSafe");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || root, "FnzSafe");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || root, ".local", "share"), "FnzSafe");
}

function pidFilePath(name) {
  return path.join(appSupportDir(), name);
}

function writeManagedPidFile(file, child, command, args) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: child.pid,
        executable: [command, ...args].join(" "),
      }),
    );
    fs.chmodSync(file, 0o600);
  } catch (error) {
    console.warn(`[dev:stack] failed to write PID file ${file}: ${error.message}`);
  }
}

function removeOwnedPidFile(file, pid) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number(record.pid) === Number(pid)) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    /* missing or stale PID file */
  }
}

function runCleanupScript({ fatal }) {
  const { execFileSync } = require("node:child_process");
  try {
    execFileSync(process.execPath, [cleanupScript], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
  } catch (error) {
    if (!fatal) return;
    const status = typeof error.status === "number" ? error.status : 1;
    process.exit(status);
  }
}

function spawnManaged(label, command, args, env, pidFileName) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
    detached: false,
    env,
  });
  const pidFile = pidFileName ? pidFilePath(pidFileName) : null;
  if (pidFile) {
    writeManagedPidFile(pidFile, child, command, args);
  }
  children.push({ child, pidFile });

  child.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`[dev:stack] ${label} failed to start: ${error.message}`);
    }
  });

  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev:stack] ${label} exited (${signal || `code ${code ?? 0}`}); stopping stack`);
      cleanup();
      process.exit(code ?? (signal ? 1 : 0));
    }
  });

  return child;
}

function stopProcess(entry, signal = "SIGTERM") {
  const child = entry?.child ?? entry;
  if (!child || !child.pid) return;
  try {
    if (isWindows) {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
  if (entry?.pidFile) {
    removeOwnedPidFile(entry.pidFile, child.pid);
  }
}

function cleanup(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of children) {
    stopProcess(entry, signal);
  }
  runCleanupScript({ fatal: false });
}

runCleanupScript({ fatal: true });

const token = sharedApiToken();
const publicToken = process.env.FNZERO_SAFE_NATIVE_PROXY === "1" ? "" : token;
const env = {
  ...process.env,
  FNZERO_SAFE_API_TOKEN: token,
  NEXT_PUBLIC_FNZERO_SAFE_API_TOKEN: publicToken,
  SOL_SAFEKEY_API_TOKEN: token,
  NEXT_PUBLIC_SOL_SAFEKEY_API_TOKEN: publicToken,
  FNZERO_SAFE_DB_PATH: desktopDatabasePath(),
};

spawnManaged("Next.js", "npm", ["exec", "--", "next", "dev", "-H", "127.0.0.1", "-p", "3840"], env, desktopWebPidFileName);
spawnManaged(
  "Rust API",
  "cargo",
  ["run", "--release", "-p", "fnzero-safe-desktop-api", "--features", "developer-wallet-maintenance"],
  env,
  desktopApiPidFileName,
);

process.once("SIGINT", () => {
  cleanup("SIGINT");
  process.exit(130);
});

process.once("SIGTERM", () => {
  cleanup("SIGTERM");
  process.exit(143);
});

process.once("exit", () => cleanup());
