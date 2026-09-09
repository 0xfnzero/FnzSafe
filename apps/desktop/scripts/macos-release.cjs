/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  console.error(`[macos-release] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed${output.trim() ? `:\n${output.trim()}` : ""}`);
  }
  return output;
}

function requireCompleteGroup(names) {
  const present = names.filter((name) => Boolean(process.env[name]?.trim()));
  if (present.length > 0 && present.length !== names.length) {
    const missing = names.filter((name) => !process.env[name]?.trim());
    fail(`incomplete notarization credentials; missing ${missing.join(", ")}`);
  }
  return present.length === names.length;
}

function preflight() {
  if (process.platform !== "darwin") {
    fail("macOS release packages must be built on macOS");
  }

  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity) {
    fail("APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate");
  }
  if (!identity.startsWith("Developer ID Application:")) {
    fail("APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate");
  }

  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const identityLine = identities
    .split("\n")
    .find((line) => line.includes(identity));
  const importedCertificate = Boolean(process.env.APPLE_CERTIFICATE?.trim());

  if (!identityLine && !importedCertificate) {
    fail(`signing identity is not available in the keychain: ${identity}`);
  }
  if (importedCertificate && !process.env.APPLE_CERTIFICATE_PASSWORD?.trim()) {
    fail("APPLE_CERTIFICATE_PASSWORD is required with APPLE_CERTIFICATE");
  }

  const hasAppleIdAuth = requireCompleteGroup([
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ]);
  const hasApiKeyAuth = requireCompleteGroup([
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
  ]);
  if (!hasAppleIdAuth && !hasApiKeyAuth) {
    fail("notarization credentials are required (Apple ID triplet or App Store Connect API key triplet)");
  }
  if (hasApiKeyAuth && !fs.isFileSync(process.env.APPLE_API_KEY_PATH)) {
    fail(`APPLE_API_KEY_PATH does not point to a file: ${process.env.APPLE_API_KEY_PATH}`);
  }

  console.log("[macos-release] Developer ID signing and notarization credentials are configured");
}

function findArtifacts(root) {
  if (!fs.existsSync(root)) return [];
  const artifacts = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "FnzSafe.app") artifacts.push(entryPath);
        else pending.push(entryPath);
      } else if (entry.isFile() && /^FnzSafe_.*\.dmg$/.test(entry.name)) {
        artifacts.push(entryPath);
      }
    }
  }
  return artifacts;
}

function verify(root) {
  const artifacts = findArtifacts(path.resolve(root));
  const apps = artifacts.filter((artifact) => artifact.endsWith(".app"));
  const dmgs = artifacts.filter((artifact) => artifact.endsWith(".dmg"));
  if (apps.length === 0 || dmgs.length === 0) {
    fail(`expected a FnzSafe.app and FnzSafe_*.dmg under ${root}`);
  }

  for (const app of apps) {
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
    const details = run("codesign", ["-dvvv", app]);
    if (!details.includes("Authority=Developer ID Application:") || details.includes("Signature=adhoc")) {
      fail(`${app} is not signed with Developer ID Application`);
    }
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "--type", "execute", "-vv", app]);
  }

  for (const dmg of dmgs) {
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", dmg]);
    const details = run("codesign", ["-dvvv", dmg]);
    if (!details.includes("Authority=Developer ID Application:") || details.includes("Signature=adhoc")) {
      fail(`${dmg} is not signed with Developer ID Application`);
    }
    run("xcrun", ["stapler", "validate", dmg]);
    run("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "-vv",
      dmg,
    ]);
  }

  console.log(`[macos-release] verified ${apps.length} app bundle(s) and ${dmgs.length} disk image(s)`);
}

const [command, argument] = process.argv.slice(2);
if (command === "preflight" && !argument) preflight();
else if (command === "verify" && argument) verify(argument);
else fail("usage: node macos-release.cjs preflight | verify <artifact-directory>");
