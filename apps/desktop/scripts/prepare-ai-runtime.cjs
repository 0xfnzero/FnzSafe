const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(desktopRoot, "ai-runtime");
const sdkManifest = path.join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh-sdk-client", "package.json");
const outputRoot = path.resolve(desktopRoot, "..", "..", "build-cache", "ai-runtime");
const binaryName = "node";
const outputBinary = path.join(outputRoot, binaryName);
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (!Number.isInteger(nodeMajor) || nodeMajor < 22 || nodeMajor >= 25) {
  throw new Error(`FnzSafe AI runtime requires Node.js 22-24; current runtime is ${process.version}.`);
}

if (!fs.existsSync(sdkManifest)) {
  throw new Error("FnzSafe AI runtime dependencies are missing. Run npm run install:ai-runtime.");
}

fs.mkdirSync(outputRoot, { recursive: true });
fs.copyFileSync(process.execPath, outputBinary);
if (process.platform !== "win32") {
  fs.chmodSync(outputBinary, 0o755);
}

console.log(`[ai-runtime] prepared ${outputBinary}`);
