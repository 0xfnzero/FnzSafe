const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const root = require("node:path").resolve(__dirname, "..");
const isWindows = process.platform === "win32";

let shuttingDown = false;
let devStack = null;
let tauri = null;
let devStackExitStatus = null;
let desktopLaunchStarted = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sharedApiToken() {
  const existing = String(process.env.FNZERO_SAFE_API_TOKEN || process.env.SOL_SAFEKEY_API_TOKEN || "").trim();
  return existing || randomBytes(32).toString("base64url");
}

function spawnManaged(label, command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
    detached: !isWindows,
    env,
  });

  child.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`[desktop:dev] ${label} failed to start: ${error.message}`);
    }
  });

  return child;
}

function stopProcess(child, signal = "SIGTERM") {
  if (!child || !child.pid) {
    return;
  }

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
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopProcess(tauri, signal);
  stopProcess(devStack, signal);
}

async function fetchOk(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function formatExit({ code, signal }) {
  if (signal) {
    return signal;
  }
  if (code === null || code === undefined) {
    return "unknown status";
  }
  return `code ${code}`;
}

async function waitForDevStack(timeoutMs = 120000) {
  const endpoints = [
    { label: "Next.js", url: "http://127.0.0.1:3840/en/", ready: false },
    { label: "Rust API", url: "http://127.0.0.1:3841/api/health", ready: false },
  ];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (devStackExitStatus) {
      throw new Error(
        `dev stack exited before desktop app started (${formatExit(devStackExitStatus)})`,
      );
    }

    for (const endpoint of endpoints) {
      if (endpoint.ready) {
        continue;
      }
      endpoint.ready = await fetchOk(endpoint.url);
      if (endpoint.ready) {
        console.log(`[desktop:dev] ${endpoint.label} is ready: ${endpoint.url}`);
      }
    }

    if (endpoints.every((endpoint) => endpoint.ready)) {
      return;
    }

    await wait(750);
  }

  const pending = endpoints
    .filter((endpoint) => !endpoint.ready)
    .map((endpoint) => endpoint.label)
    .join(", ");
  throw new Error(`${pending} did not become ready within ${timeoutMs / 1000}s`);
}

async function main() {
  const token = sharedApiToken();
  const sharedEnv = {
    ...process.env,
    FNZERO_SAFE_API_TOKEN: token,
    NEXT_PUBLIC_FNZERO_SAFE_API_TOKEN: token,
    SOL_SAFEKEY_API_TOKEN: token,
    NEXT_PUBLIC_SOL_SAFEKEY_API_TOKEN: token,
  };

  devStack = spawnManaged("dev stack", "npm", ["run", "dev:stack"], sharedEnv);
  devStack.once("exit", (code, signal) => {
    devStackExitStatus = { code, signal };
    if (!shuttingDown && desktopLaunchStarted) {
      console.error(`[desktop:dev] dev stack exited (${formatExit(devStackExitStatus)}); stopping Tauri`);
      cleanup();
      process.exit(code ?? 1);
    }
  });

  await waitForDevStack();
  if (devStackExitStatus) {
    throw new Error(`dev stack exited before desktop app started (${formatExit(devStackExitStatus)})`);
  }

  console.log("[desktop:dev] starting Tauri after the web/API stack is ready");
  desktopLaunchStarted = true;
  tauri = spawnManaged(
    "Tauri",
    "npm",
    [
      "run",
      "tauri",
      "--",
      "dev",
      "--config",
      "src-tauri/tauri.desktop-dev.conf.json",
    ],
    sharedEnv,
  );

  const { code, signal } = await waitForExit(tauri);
  cleanup();

  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 0);
}

process.once("SIGINT", () => {
  cleanup("SIGINT");
  process.exit(130);
});

process.once("SIGTERM", () => {
  cleanup("SIGTERM");
  process.exit(143);
});

process.once("exit", () => cleanup());

main().catch((error) => {
  console.error(`[desktop:dev] ${error.message}`);
  cleanup();
  process.exit(1);
});
