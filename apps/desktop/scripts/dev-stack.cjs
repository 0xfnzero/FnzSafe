const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(root, "../..");
const isWindows = process.platform === "win32";
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

function spawnManaged(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
    detached: !isWindows,
    env,
  });
  children.push(child);

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

function stopProcess(child, signal = "SIGTERM") {
  if (!child || !child.pid || child.exitCode !== null || child.killed) return;
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
}

function cleanup(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    stopProcess(child, signal);
  }
}

const token = sharedApiToken();
const env = {
  ...process.env,
  FNZERO_SAFE_API_TOKEN: token,
  NEXT_PUBLIC_FNZERO_SAFE_API_TOKEN: token,
  SOL_SAFEKEY_API_TOKEN: token,
  NEXT_PUBLIC_SOL_SAFEKEY_API_TOKEN: token,
  FNZERO_SAFE_DB_PATH: desktopDatabasePath(),
};

spawnManaged("Next.js", "npm", ["exec", "--", "next", "dev", "-H", "127.0.0.1", "-p", "3840"], env);
spawnManaged("Rust API", "cargo", ["run", "--release", "-p", "fnzero-safe-desktop-api"], env);

process.once("SIGINT", () => {
  cleanup("SIGINT");
  process.exit(130);
});

process.once("SIGTERM", () => {
  cleanup("SIGTERM");
  process.exit(143);
});

process.once("exit", () => cleanup());
