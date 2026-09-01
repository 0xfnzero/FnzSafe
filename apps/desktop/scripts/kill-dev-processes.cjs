const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const uiRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(uiRoot, "../..");
const ports = ["3840", process.env.FNZERO_SAFE_API_PORT || process.env.SOL_SAFEKEY_API_PORT || "3841"];
const isWindows = process.platform === "win32";
const desktopApiBinaryNames = new Set([
  "fnzero-safe-desktop-api",
  "fnzero-safe-desktop-api.exe",
]);
const managedPidFileNames = [
  "desktop.pid",
  "desktop-app.pid",
  "desktop-api.pid",
  "desktop-web.pid",
];

function exec(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function execFile(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function commandLine(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return "";
  if (isWindows) {
    return execFile("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${numericPid}').CommandLine`,
    ]);
  }
  return exec(`ps -p ${numericPid} -o command=`);
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

function appSupportDir() {
  const dbPath = String(process.env.FNZERO_SAFE_DB_PATH || process.env.SOL_SAFEKEY_DB_PATH || "").trim();
  if (dbPath) return path.dirname(dbPath);
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || uiRoot, "Library", "Application Support", "FnzSafe");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || uiRoot, "FnzSafe");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || uiRoot, ".local", "share"), "FnzSafe");
}

function managedPidRecords() {
  const directories = [
    appSupportDir(),
    path.join(uiRoot, "data"),
    path.join(workspaceRoot, "crates", "desktop-api", "data"),
  ];
  const files = directories.flatMap((directory) =>
    managedPidFileNames.map((name) => path.join(directory, name)),
  );
  const records = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const pid = Number(data.pid);
      const executable = String(data.executable || "").trim();
      if (Number.isInteger(pid) && pid > 1 && executable) {
        records.push({ pid, executable, file });
      }
    } catch {
      /* missing or stale PID file */
    }
  }
  return records;
}

function executableBasename(value) {
  return path.basename(String(value || "").trim());
}

function managedRecordStillMatches(record) {
  const command = commandLine(record.pid);
  if (!command) return false;
  const executableName = executableBasename(record.executable);
  if (desktopApiBinaryNames.has(executableName)) {
    return command.includes(executableName);
  }
  if (command === record.executable || command.startsWith(`${record.executable} `)) {
    return true;
  }
  if (record.executable.includes("next dev")) {
    return /next(\s+dev|-server)/.test(command);
  }
  if (record.executable.includes("fnzero-safe-desktop-api")) {
    return command.includes("fnzero-safe-desktop-api");
  }
  if (executableName === "FnzSafe" || executableName === "FnzeroSafe") {
    return command.includes("/FnzSafe.app/Contents/MacOS/") || command.includes("/FnzeroSafe.app/Contents/MacOS/");
  }
  return false;
}

function managedRecordIsStale(record) {
  return !commandLine(record.pid);
}

function ancestorPids() {
  const pids = new Set([process.pid]);
  let pid = process.ppid;
  while (pid && !pids.has(pid)) {
    pids.add(pid);
    const parent = isWindows
      ? Number(execFile("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').ParentProcessId`,
        ]))
      : Number(exec(`ps -p ${Number(pid)} -o ppid=`));
    if (!Number.isInteger(parent) || parent <= 1) break;
    pid = parent;
  }
  return pids;
}

function pidsListeningOnPort(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return [];
  if (isWindows) {
    return execFile("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${numericPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
    ]).split(/\s+/).filter(Boolean);
  }
  return exec(`lsof -nP -iTCP:${numericPort} -sTCP:LISTEN -t`).split(/\s+/).filter(Boolean);
}

function isProjectProcess(pid) {
  const cwd = processCwd(pid);
  const command = commandLine(pid);
  const comparableCommand = isWindows ? command.toLowerCase() : command;
  const comparableUiRoot = isWindows ? uiRoot.toLowerCase() : uiRoot;
  const comparableWorkspaceRoot = isWindows ? workspaceRoot.toLowerCase() : workspaceRoot;
  return (
    cwd === uiRoot ||
    cwd === workspaceRoot ||
    comparableCommand.includes(`${comparableUiRoot}${path.sep}`) ||
    comparableCommand.includes(`${comparableWorkspaceRoot}${path.sep}`)
  );
}

function isFnzSafeProcess(pid) {
  const command = commandLine(pid);
  if (!command) return false;
  const normalizedCommand = command.replace(/\\/g, "/");
  return (
    isProjectProcess(pid) ||
    normalizedCommand.includes("fnzero-safe-desktop-api") ||
    normalizedCommand.includes("/FnzSafe.app/Contents/MacOS/FnzSafe") ||
    normalizedCommand.includes("/FnzeroSafe.app/Contents/MacOS/FnzeroSafe") ||
    normalizedCommand.includes("/FnzSafe.app/Contents/MacOS/FnzeroSafe") ||
    normalizedCommand.includes("scripts/dev-stack.cjs") ||
    normalizedCommand.includes("scripts/desktop-dev.cjs")
  );
}

function matchingProjectPids() {
  if (isWindows) return [];
  const patterns = [
    "next (dev|build)",
    "next-server",
    "tauri dev",
    "scripts/dev-stack.cjs",
    "scripts/desktop-dev.cjs",
    "build-cache/debug/FnzeroSafe",
    "build-cache/debug/FnzSafe",
    "build-cache/release/FnzeroSafe",
    "build-cache/release/FnzSafe",
    "build-cache/release/bundle/macos/FnzeroSafe.app/Contents/MacOS/FnzeroSafe",
    "build-cache/release/bundle/macos/FnzSafe.app/Contents/MacOS/FnzSafe",
    "build-cache/release/fnzero-safe-desktop-api",
  ];
  const pids = new Set();
  for (const pattern of patterns) {
    for (const pid of exec(`pgrep -f '${pattern}'`).split(/\s+/).filter(Boolean)) {
      if (isProjectProcess(pid)) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
}

function isRunning(pid) {
  if (!isWindows) {
    const state = exec(`ps -p ${Number(pid)} -o stat=`);
    if (!state || state.startsWith("Z")) return false;
  }
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
  if (targets.length === 0) {
    console.log("[dev:cleanup] no local FnzSafe development processes are running");
    return;
  }

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

  const forceDeadline = Date.now() + 2000;
  while (targets.some(isRunning) && Date.now() < forceDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  const remaining = targets.filter(isRunning);
  if (remaining.length > 0) {
    console.error(`[dev:cleanup] unable to stop PID(s): ${remaining.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("[dev:cleanup] all local FnzSafe development processes stopped");
}

const records = managedPidRecords();
const pids = new Set(matchingProjectPids());
for (const record of records) {
  if (managedRecordStillMatches(record)) {
    pids.add(String(record.pid));
  }
}
for (const port of ports) {
  for (const pid of pidsListeningOnPort(port)) {
    if (isFnzSafeProcess(pid)) {
      pids.add(pid);
    }
  }
}
stopPids([...pids]);
if (process.exitCode !== 1) {
  const stopped = new Set([...pids].map((pid) => Number(pid)));
  for (const record of records) {
    if (!stopped.has(Number(record.pid)) && !managedRecordIsStale(record)) continue;
    try {
      fs.rmSync(record.file, { force: true });
    } catch {
      /* ignore */
    }
  }
}
