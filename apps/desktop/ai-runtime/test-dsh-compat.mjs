#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const dshVersion = createRequire(import.meta.url)('@deepseek-ai/dsh-sdk-client/package.json').version;
const testRoot = path.join(os.tmpdir(), 'fnzsafe-dsh-compat');
const workspaceRoot = path.join(testRoot, 'workspace');
const dshHome = path.join(testRoot, 'home');
const walletDir = path.join(testRoot, 'binance-web3-wallet');
const previewSecret = 'fnzsafe-dsh-compat-preview-secret-0000000000000000';

await Promise.all([
  fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
  fs.mkdir(dshHome, { recursive: true, mode: 0o700 }),
  fs.mkdir(walletDir, { recursive: true, mode: 0o700 }),
]);

const inherited = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR'];
const env = Object.fromEntries(inherited.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
Object.assign(env, {
  DEEPSEEK_API_KEY: 'offline-compatibility-test',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DSH_HOME: dshHome,
  DSH_PERMISSION_MODE: 'read-only',
  DSH_TELEMETRY_DISABLED: '1',
  FNZSAFE_DSH_MODEL: 'deepseek-chat',
  FNZSAFE_DSH_SKILL_ROOT: path.join(runtimeRoot, 'skills'),
  FNZSAFE_DSH_SYSTEM_PROMPT: 'Offline FnzSafe DSH compatibility test. Do not run a model turn.',
  FNZSAFE_WEB3_MCP_SERVER_PATH: path.join(runtimeRoot, 'plugins', 'web3-market-mcp.mjs'),
  FNZSAFE_BINANCE_AGENTIC_MCP_PROXY_PATH: path.join(runtimeRoot, 'plugins', 'binance-agentic-mcp-proxy.mjs'),
  FNZSAFE_BINANCE_WEB3_WALLET_MCP_PATH: path.join(runtimeRoot, 'plugins', 'binance-web3-wallet-mcp.mjs'),
  FNZSAFE_BINANCE_AGENTIC_MCP_ENABLED: '0',
  FNZSAFE_BINANCE_MCP_CONFIG_DIR: path.join(testRoot, 'binance-agentic-oauth'),
  FNZSAFE_BINANCE_WEB3_WALLET_DIR: walletDir,
  FNZSAFE_BINANCE_SKILL_ROOT: path.join(testRoot, 'binance-skills'),
  FNZSAFE_WALLET_API_URL: 'http://127.0.0.1:9/api',
  FNZSAFE_WALLET_API_TOKEN: previewSecret,
  FNZSAFE_BINANCE_ENVIRONMENT: 'testnet',
  FNZSAFE_BINANCE_TRADING_ENABLED: '0',
  FNZSAFE_BINANCE_MAX_ORDER_QUOTE: '100',
  FNZSAFE_BINANCE_USER_CONFIRMED: '0',
});

const harness = new DeepSeekHarness({
  cwd: workspaceRoot,
  processCwd: workspaceRoot,
  profile: 'sdk-minimal',
  patches: [path.join(runtimeRoot, 'fnzsafe.patch.yml')],
  dshHome,
  env,
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  initializeTimeoutMs: 30_000,
  requestTimeoutMs: 30_000,
  shutdownTimeoutMs: 1_000,
  disposeEofGraceMs: 6_000,
  disposeGraceMs: 3_000,
});

try {
  await harness.start();
  process.stdout.write(`${JSON.stringify({ ok: true, dsh: dshVersion, profile: 'sdk-minimal' })}\n`);
} finally {
  await harness.close();
}
