const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const uiRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(uiRoot, "..");
const ports = ["3840", process.env.FNZERO_SAFE_API_PORT || process.env.SOL_SAFEKEY_API_PORT || "3841"];
const isWindows = process.platform === "win32";

function exec(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function commandLine(pid) {
  if (isWindows) return "";
  return exec(`ps -p ${pid} -o command=`);
}

function processCwd(pid) {
  if (isWindows) return "";
  try {
    return fs.realpathSync(`/proc/${pid}/cwd`);
  } catch {
    if (process.platform === "darwin") {
      const out = exec(`lsof -a -d cwd -p ${pid} -Fn`);
      const cwd = out.split("\n").find((line) => line.startsWith("n"))?.slice(1) || "";
      try {
        return cwd ? fs.realpathSync(cwd) : "";
      } catch {
        return cwd;
      }
    }
    return "";
  }
}

function ancestorPids() {
  const pids = new Set([process.pid]);
  let pid = process.ppid;
  while (pid && !pids.has(pid)) {
    pids.add(pid);
    const parent = Number(exec(`ps -p ${pid} -o ppid=`));
    if (!Number.isInteger(parent) || parent <= 1) break;
    pid = parent;
  }
  return pids;
}

function pidsListeningOnPort(port) {
  if (isWindows) {
    const command = [
      "powershell",
      "-NoProfile",
      "-Command",
      `"Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
    ].join(" ");
    return exec(command).split(/\s+/).filter(Boolean);
  }
  return exec(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).split(/\s+/).filter(Boolean);
}

function matchingProjectPids() {
  if (isWindows) return [];
  const patterns = [
    "next (dev|build)",
    "next-server",
    "tauri dev",
    "scripts/dev-stack.cjs",
    "scripts/desktop-dev.cjs",
    "build-cache/debug/FnzSafe",
    "build-cache/release/fnzero-safe-desktop-api",
  ];
  const pids = new Set();
  for (const pattern of patterns) {
    for (const pid of exec(`pgrep -f '${pattern}'`).split(/\s+/).filter(Boolean)) {
      const cwd = processCwd(pid);
      const command = commandLine(pid);
      if (
        cwd === uiRoot ||
        cwd === workspaceRoot ||
        command.includes(`${uiRoot}${path.sep}`) ||
        command.includes(`${workspaceRoot}${path.sep}`)
      ) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
}

function isRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function stopPids(pids) {
  const protectedPids = ancestorPids();
  const targets = [...new Set(pids.map(Number))]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && !protectedPids.has(pid));
  if (targets.length === 0) return;

  console.log(`[dev:cleanup] stopping stale process PID(s): ${targets.join(", ")}`);
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }

  const deadline = Date.now() + 3000;
  while (targets.some(isRunning) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  for (const pid of targets) {
    if (!isRunning(pid)) continue;
    console.log(`[dev:cleanup] force stopping stale process ${pid}`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

const pids = new Set(matchingProjectPids());
for (const port of ports) {
  for (const pid of pidsListeningOnPort(port)) {
    pids.add(pid);
  }
}
stopPids([...pids]);
