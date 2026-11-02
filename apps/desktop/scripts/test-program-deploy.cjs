const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const uiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(uiRoot, "..", "..");
const deploymentPage = fs.readFileSync(
  path.join(uiRoot, "src", "app", "[locale]", "page.tsx"),
  "utf8",
);
const genericBoundaryFiles = [
  path.join("src", "components", "FieldHelp.tsx"),
  path.join("src", "lib", "apiPath.ts"),
  path.join("src", "lib", "apiPath.test.ts"),
  path.join("src", "lib", "anchorIdl.ts"),
  path.join("src", "lib", "anchorIdl.test.ts"),
  path.join("src", "lib", "programDeploy.ts"),
  path.join("src", "lib", "programDeploy.test.ts"),
];
const genericBoundarySources = genericBoundaryFiles.map((relativePath) => [
  relativePath,
  fs.readFileSync(path.join(uiRoot, relativePath), "utf8"),
]);
const fieldHelpComponent = genericBoundarySources[0][1];
const projectSpecificName = ["fn", "zero"].join("");
const projectSpecificNamePattern = new RegExp(projectSpecificName, "i");

for (const [relativePath, source] of genericBoundarySources) {
  assert.doesNotMatch(
    source,
    projectSpecificNamePattern,
    `${relativePath} must remain project-agnostic`,
  );
}

assert.match(deploymentPage, /apiFetch\("program\/deploy"/);
assert.match(deploymentPage, /apiFetch\("program\/upgrade"/);
assert.match(deploymentPage, /openProgramProjectDirectUpgrade/);
assert.match(deploymentPage, /removeProgramDeploymentHistoryRecord/);
assert.match(deploymentPage, /features\.program-projects\.historyRemoveConfirm/);
assert.match(deploymentPage, /buildProgramDeploymentReceiptJson\(/);

const backendMain = fs.readFileSync(
  path.join(repoRoot, "crates", "desktop-api", "src", "main.rs"),
  "utf8",
);
assert.match(backendMain, /route\("\/api\/program\/upgrade", post\(upgrade_generic_program\)\)/);
assert.match(backendMain, /struct UpgradeProgramRequest/);
assert.match(backendMain, /#\[serde\(deny_unknown_fields\)\]\s*struct UpgradeProgramRequest/);
assert.match(backendMain, /squads_v4::upgrade_program_ix\(/);
assert.doesNotMatch(
  backendMain.slice(
    backendMain.indexOf("async fn upgrade_program"),
    backendMain.indexOf("async fn program_info"),
  ),
  /set_buffer_authority|vault_pda|require_squads_member/,
  "direct upgrade must not hand authority to a Squads vault",
);
assert.match(deploymentPage, /const programSoBase64 = btoa\(binary\);/);
assert.match(deploymentPage, /programSoBase64,\s*programSoName:/);
assert.doesNotMatch(deploymentPage, /programSoBase64:\s*btoa\(binary\)/);
assert.doesNotMatch(deploymentPage, /devnet\/deploy/i);
assert.doesNotMatch(
  deploymentPage,
  /account\.isSigner\s*&&\s*walletAddress/,
  "generic function calls must not guess signer accounts from the current wallet",
);
assert.doesNotMatch(
  deploymentPage,
  /signerAccounts\[0\]/,
  "generic function calls must not auto-fill the first signer account",
);
assert.match(
  deploymentPage,
  /seed\.kind === "arg"/,
  "generic function calls must derive PDA accounts from Anchor arg seeds",
);
assert.match(
  deploymentPage,
  /readOnly=\{isAutoAccount\}/,
  "deterministic IDL accounts must be read-only in the generic function caller",
);
assert.match(
  deploymentPage,
  /programInvokeFriendlyError/,
  "generic function calls must convert common RPC and Anchor errors into user-facing messages",
);
assert.match(
  deploymentPage,
  /rawErrorMessage/,
  "generic function calls must preserve raw errors alongside friendly messages",
);
assert.match(fieldHelpComponent, /CircleHelp/);
assert.match(fieldHelpComponent, /Tooltip\.Trigger/);
assert.match(fieldHelpComponent, /Tooltip\.Portal/);
assert.match(fieldHelpComponent, /closeOnClick=\{false\}/);
assert.match(fieldHelpComponent, /data-field-help/);
assert.match(fieldHelpComponent, /aria-describedby=\{tooltipId\}/);
assert.match(fieldHelpComponent, /role="tooltip"/);

const tooltipKeys = [
  "deploymentWalletTooltip",
  "derivedProgramIdTooltip",
  "expectedGenesisHashTooltip",
  "expectedProgramIdTooltip",
  "expectedUpgradeAuthorityTooltip",
  "journalTooltip",
  "maxDataLenTooltip",
  "programFileTooltip",
  "programKeypairFileTooltip",
  "resumeBufferAddressTooltip",
  "uploadedProgramSha256Tooltip",
  "walletPasswordTooltip",
];
for (const locale of ["en", "zh"]) {
  const messages = JSON.parse(
    fs.readFileSync(path.join(uiRoot, "src", "messages", `${locale}.json`), "utf8"),
  );
  const deploymentMessages = messages.features?.["program-deploy"];
  assert.equal(typeof deploymentMessages?.helpAriaLabel, "string");
  assert.ok(deploymentMessages.helpAriaLabel.includes("{field}"));
  for (const key of tooltipKeys) {
    assert.equal(typeof deploymentMessages?.[key], "string", `${locale}.${key} is required`);
    assert.ok(deploymentMessages[key].trim().length > 0, `${locale}.${key} must not be empty`);
  }
  const upgradeMessages = messages.features?.["program-upgrade"];
  for (const key of [
    "title",
    "hint",
    "upgradeButton",
    "upgrading",
    "success",
    "error",
    "fillAllFields",
  ]) {
    assert.equal(typeof upgradeMessages?.[key], "string", `${locale}.program-upgrade.${key}`);
  }
  const projectMessages = messages.features?.["program-projects"];
  for (const key of [
    "openDirectUpgrade",
    "removeHistoryRecord",
    "historyRemoveConfirm",
  ]) {
    assert.equal(typeof projectMessages?.[key], "string", `${locale}.program-projects.${key}`);
  }
  assert.equal(typeof projectMessages?.planKinds?.["direct-upgrade"], "string");
  assert.equal(typeof projectMessages?.historyKinds?.["direct-upgrade"], "string");
  const invokeMessages = messages.features?.["program-invoke"];
  for (const key of [
    "friendlyMissingPayerAccount",
    "friendlyInsufficientLamports",
    "friendlyAnchorErrorWithHint",
    "friendlyDeclaredProgramIdMismatch",
    "rawErrorLog",
    "rawSimulationErrorLog",
  ]) {
    assert.equal(typeof invokeMessages?.[key], "string", `${locale}.${key} is required`);
    assert.ok(invokeMessages[key].trim().length > 0, `${locale}.${key} must not be empty`);
  }
}
for (const key of tooltipKeys) {
  assert.ok(
    deploymentPage.includes(`features.program-deploy.${key}`),
    `deployment UI must render ${key}`,
  );
}

const outputDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "fnzero-safe-program-deploy-"),
);

try {
  const compiler = path.join(uiRoot, "node_modules", "typescript", "bin", "tsc");
  const libDirectory = path.join(uiRoot, "src", "lib");
  const testSources = fs
    .readdirSync(libDirectory)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => path.join(libDirectory, name));
  const sources = [
    ...new Set([
      path.join(libDirectory, "appStorage.ts"),
      path.join(libDirectory, "programDeploy.ts"),
      ...testSources,
    ]),
  ];
  const compile = spawnSync(
    process.execPath,
    [
      compiler,
      ...sources,
      "--outDir",
      outputDirectory,
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--target",
      "ES2020",
      "--rewriteRelativeImportExtensions",
      "--esModuleInterop",
      "--skipLibCheck",
    ],
    { cwd: uiRoot, encoding: "utf8" },
  );
  if (compile.status !== 0) {
    process.stderr.write(compile.stdout || "");
    process.stderr.write(compile.stderr || "");
    process.exitCode = compile.status || 1;
  } else {
    const compiledTests = testSources.map((source) =>
      path.join(outputDirectory, path.basename(source, ".ts") + ".js"),
    );
    const run = spawnSync(process.execPath, ["--test", ...compiledTests], {
      cwd: uiRoot,
      env: {
        ...process.env,
        NODE_PATH: [path.join(uiRoot, "node_modules"), process.env.NODE_PATH]
          .filter(Boolean).join(path.delimiter),
      },
      encoding: "utf8",
      stdio: "inherit",
    });
    process.exitCode = run.status ?? 1;
  }
} finally {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
}
