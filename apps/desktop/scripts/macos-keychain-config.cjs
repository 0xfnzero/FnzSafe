/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function mergeConfig(base, extra) {
  return { ...base, ...extra, bundle: { ...base.bundle, ...extra.bundle,
    macOS: { ...base.bundle?.macOS, ...extra.bundle?.macOS } } };
}

function certificateTeam(identity) {
  // Apple Development's parenthesized identifier is not necessarily the team.
  // Read only the public certificate subject; never export its private key.
  const certificate = execFileSync("/usr/bin/security", ["find-certificate", "-c", identity, "-p"], { encoding: "utf8" });
  const subject = execFileSync("/usr/bin/openssl", ["x509", "-noout", "-subject", "-nameopt", "RFC2253"], { input: certificate, encoding: "utf8" });
  return /(?:^|,)OU=([A-Z0-9]{10})(?:,|$)/m.exec(subject)?.[1];
}

function macosKeychainOverride(args, root, env = process.env, resolveTeam = certificateTeam) {
  if (!["dev", "build", "bundle"].includes(args[0])) return null;
  let config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  for (let i = 1; i < args.length; i++) {
    let value;
    if (args[i] === "--config" || args[i] === "-c") value = args[++i];
    else if (args[i].startsWith("--config=")) value = args[i].slice(9);
    if (value) {
      const extra = value.trim().startsWith("{") ? JSON.parse(value)
        : JSON.parse(fs.readFileSync(path.resolve(root, value), "utf8"));
      config = mergeConfig(config, extra);
    }
  }
  const identity = env.APPLE_SIGNING_IDENTITY?.trim() || config.bundle?.macOS?.signingIdentity;
  if (env.FNZSAFE_LOCAL_VALIDATION === "1") {
    if (!identity?.startsWith("Apple Development:") || config.bundle?.macOS?.entitlements) {
      throw new Error("Local validation requires Apple Development signing and no protected Keychain entitlements");
    }
    // Without a provisioning profile, macOS rejects restricted entitlements.
    // Password unlock remains available; protected Keychain calls fail closed.
    return null;
  }
  if (!identity || identity === "-") return null;
  const identityTeam = identity.startsWith("Developer ID Application:") ? /\(([A-Z0-9]{10})\)$/.exec(identity)?.[1] : undefined;
  const team = env.APPLE_TEAM_ID?.trim() || identityTeam || (identity.startsWith("Apple Development:") ? resolveTeam(identity) : undefined);
  if (!team || !/^[A-Z0-9]{10}$/.test(team)) {
    throw new Error("Signed builds need a signing identity ending in (TEAMID), or APPLE_TEAM_ID, for protected Keychain access");
  }
  if (!/^[A-Za-z0-9.-]+$/.test(config.identifier || "")) throw new Error("Invalid application identifier");
  const existing = config.bundle?.macOS?.entitlements;
  if (typeof existing === "string") {
    throw new Error("Use inline macOS entitlements so the protected Keychain identity can be merged and checked");
  }
  const applicationId = `${team}.${config.identifier}`;
  return { bundle: { macOS: { entitlements: {
    ...existing,
    "com.apple.application-identifier": applicationId,
    "com.apple.developer.team-identifier": team,
    "keychain-access-groups": [applicationId],
  } } } };
}

module.exports = { macosKeychainOverride };
