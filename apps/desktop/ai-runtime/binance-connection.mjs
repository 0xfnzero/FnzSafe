#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const AGENTIC_MCP_URL = 'https://agent.binance.com/mcp/agentic';
const CLIENT_METADATA_URL = 'https://raw.githack.com/0xfnzero/FnzSafe/oauth-client-v1/.well-known/oauth-client/fnzsafe.json';
const MAX_INPUT_BYTES = 8 * 1024;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;

const text = (value) => String(value ?? '').trim();

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Binance connection request is too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(value)) throw new Error('Binance connection request must be an object');
  return value;
}

function requiredDirectory(name) {
  const value = text(process.env[name]);
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} is invalid`);
  return value;
}

function mcpConfigDirectory() {
  return requiredDirectory('FNZSAFE_BINANCE_MCP_CONFIG_DIR');
}

function walletDirectory() {
  return requiredDirectory('FNZSAFE_BINANCE_WEB3_WALLET_DIR');
}

function mcpServerHash() {
  return createHash('md5').update(`${AGENTIC_MCP_URL}|${CLIENT_METADATA_URL}`).digest('hex');
}

function mcpCredentialDirectory() {
  return path.join(mcpConfigDirectory(), 'mcp-remote-v1');
}

async function mcpStatus() {
  const tokenPath = path.join(mcpCredentialDirectory(), `${mcpServerHash()}_tokens.json`);
  try {
    const tokens = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
    const expiresAt = Number(tokens?.expires_at);
    const hasAccessToken = Boolean(text(tokens?.access_token));
    const hasRefreshToken = Boolean(text(tokens?.refresh_token));
    const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
    return {
      connected: hasAccessToken && (!expired || hasRefreshToken),
      refreshAvailable: hasRefreshToken,
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return { connected: false, refreshAvailable: false };
    throw error;
  }
}

async function clearMcpCredentials() {
  const directory = mcpCredentialDirectory();
  const prefix = `${mcpServerHash()}_`;
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { connected: false, refreshAvailable: false };
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => fs.unlink(path.join(directory, entry.name))));
  return mcpStatus();
}

function proxyPath() {
  return fileURLToPath(new URL('./plugins/binance-agentic-mcp-proxy.mjs', import.meta.url));
}

async function listAllTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function connectMcp() {
  await fs.mkdir(mcpConfigDirectory(), { recursive: true, mode: 0o700 });
  const client = new Client({ name: 'fnzsafe-binance-connection-check', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-addons', proxyPath()],
    env: {
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      FNZSAFE_BINANCE_MCP_CONFIG_DIR: mcpConfigDirectory(),
      FNZSAFE_AGENTIC_PREVIEW_SECRET: randomBytes(32).toString('hex'),
      FNZSAFE_BINANCE_USER_CONFIRMED: '0',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  try {
    await client.connect(transport);
    const tools = await listAllTools(client);
    const readOnlyToolCount = tools.filter((tool) => tool?.annotations?.readOnlyHint === true).length;
    return {
      ...(await mcpStatus()),
      verified: true,
      toolCount: tools.length,
      readOnlyToolCount,
      writeToolCount: tools.length - readOnlyToolCount,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function bawEntryPath() {
  const packageJsonUrl = import.meta.resolve('@binance/agentic-wallet/package.json');
  return fileURLToPath(new URL('./dist/index.js', packageJsonUrl));
}

function parseCliJson(output) {
  const source = text(output);
  if (!source) throw new Error('Binance Agentic Wallet returned an empty response');
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Binance Agentic Wallet returned invalid JSON');
    return JSON.parse(source.slice(start, end + 1));
  }
}

async function runBaw(args, timeout = READ_TIMEOUT_MS) {
  const directory = walletDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const options = {
    cwd: directory,
    env: {
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      BINANCE_BAW_DIR: directory,
      BINANCE_INSTANCE_ID: createHash('sha256').update(directory).digest('hex'),
      NO_COLOR: '1',
    },
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  };
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--no-addons', bawEntryPath(), ...args, '--json'], options);
    return parseCliJson(stdout);
  } catch (error) {
    if (text(error?.stdout)) return parseCliJson(error.stdout);
    if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('Binance Agentic Wallet request timed out');
    throw new Error(`Binance Agentic Wallet command failed: ${text(error?.message) || 'unknown error'}`);
  }
}

function qrCodeId(input) {
  const value = text(input.qrCodeId);
  if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/u.test(value)) throw new Error('qrCodeId is invalid');
  return value;
}

async function handle(input) {
  switch (input.action) {
    case 'mcp-status': return mcpStatus();
    case 'mcp-connect': return connectMcp();
    case 'mcp-reauthorize':
      await clearMcpCredentials();
      return connectMcp();
    case 'mcp-disconnect': return clearMcpCredentials();
    case 'wallet-status': return runBaw(['wallet', 'status']);
    case 'wallet-signin': return runBaw(['auth', 'signin']);
    case 'wallet-verify': return runBaw(['auth', 'verify', '--qrCodeId', qrCodeId(input)], WRITE_TIMEOUT_MS);
    case 'wallet-signout': return runBaw(['auth', 'signout'], WRITE_TIMEOUT_MS);
    default: throw new Error('unsupported Binance connection action');
  }
}

async function selfTest() {
  if (!/^[a-f0-9]{32}$/u.test(mcpServerHash())) throw new Error('Binance MCP credential hash is invalid');
  await fs.access(proxyPath());
  await fs.access(bawEntryPath());
  process.stdout.write(`${JSON.stringify({ ok: true, actions: ['mcp-status', 'mcp-connect', 'mcp-reauthorize', 'mcp-disconnect', 'wallet-status', 'wallet-signin', 'wallet-verify', 'wallet-signout'] })}\n`);
}

try {
  const result = process.argv.includes('--self-test') ? await selfTest() : await handle(await readInput());
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
