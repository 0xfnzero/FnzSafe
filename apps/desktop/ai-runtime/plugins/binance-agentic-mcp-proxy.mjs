#!/usr/bin/env node

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const AGENTIC_MCP_URL = 'https://agent.binance.com/mcp/agentic';
const CLIENT_METADATA_URL = 'https://cdn.jsdelivr.net/gh/0xfnzero/FnzSafe@main/.well-known/oauth-client/fnzsafe.json';
const CALLBACK_PORT = '19842';
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const EXECUTE_TOOL_NAME = 'fnzsafe_execute_confirmed_action';
const MUTATION_WORD = /(?:^|[_-])(approve|borrow|burn|buy|cancel|claim|configure|create|delete|deposit|execute|mint|pay|place|redeem|remove|repay|revoke|sell|send|set|sign|stake|submit|swap|trade|transfer|unstake|update|withdraw)(?:$|[_-])/iu;

const text = (value) => String(value ?? '').trim();

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function previewSecret() {
  const value = text(process.env.FNZSAFE_AGENTIC_PREVIEW_SECRET);
  if (value.length < 32) throw new Error('FnzSafe Agentic preview secret is unavailable');
  return value;
}

function sign(encoded, secret) {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

function createPreviewToken(tool, args, secret = previewSecret(), now = Date.now()) {
  const payload = {
    v: 1,
    action: 'binance-agentic-mcp',
    tool,
    arguments: isRecord(args) ? args : {},
    expiresAt: now + PREVIEW_TTL_MS,
    nonce: randomBytes(16).toString('hex'),
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

function decodePreviewToken(token, secret = previewSecret(), now = Date.now()) {
  const [encoded, signature, extra] = text(token).split('.');
  if (!encoded || !signature || extra !== undefined) throw new Error('invalid Binance Agentic preview token');
  const expected = Buffer.from(sign(encoded, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new Error('Binance Agentic preview token integrity check failed');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid Binance Agentic preview token payload');
  }
  if (!isRecord(payload)
    || payload.v !== 1
    || payload.action !== 'binance-agentic-mcp'
    || typeof payload.tool !== 'string'
    || !isRecord(payload.arguments)
    || typeof payload.expiresAt !== 'number'
    || typeof payload.nonce !== 'string'
    || !/^[a-f0-9]{32}$/u.test(payload.nonce)) {
    throw new Error('invalid Binance Agentic preview token payload');
  }
  if (payload.expiresAt <= now || payload.expiresAt > now + PREVIEW_TTL_MS) {
    throw new Error('Binance Agentic preview token expired');
  }
  return payload;
}

async function consumePreview(payload) {
  const configDir = text(process.env.FNZSAFE_BINANCE_MCP_CONFIG_DIR);
  if (!configDir || !path.isAbsolute(configDir)) throw new Error('Binance Agentic OAuth storage directory is invalid');
  const replayDir = path.join(configDir, 'fnzsafe-preview-replay');
  await fs.mkdir(replayDir, { recursive: true, mode: 0o700 });
  const markerName = createHash('sha256').update(`${payload.expiresAt}:${payload.nonce}`).digest('hex');
  try {
    const marker = await fs.open(path.join(replayDir, `${payload.expiresAt}-${markerName}`), 'wx', 0o600);
    await marker.close();
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Binance Agentic preview token was already consumed');
    throw error;
  }
  const expired = (await fs.readdir(replayDir))
    .filter((entry) => Number(entry.split('-', 1)[0]) <= Date.now())
    .slice(0, 100);
  await Promise.allSettled(expired.map((entry) => fs.unlink(path.join(replayDir, entry))));
}

function isReadOnlyTool(tool) {
  const normalizedName = text(tool?.name).replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
  return tool?.annotations?.readOnlyHint === true && !MUTATION_WORD.test(normalizedName);
}

function publicArguments(value) {
  if (Array.isArray(value)) return value.map(publicArguments);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    /(api.?key|authorization|credential|password|private.?key|secret|seed|session.?token)/iu.test(key)
      ? '[REDACTED]'
      : publicArguments(nested),
  ]));
}

function jsonResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
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

function remoteTransport() {
  const proxyPath = fileURLToPath(import.meta.resolve('mcp-remote'));
  const configDir = text(process.env.FNZSAFE_BINANCE_MCP_CONFIG_DIR);
  if (!configDir || !path.isAbsolute(configDir)) throw new Error('Binance Agentic OAuth storage directory is invalid');
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      proxyPath,
      AGENTIC_MCP_URL,
      CALLBACK_PORT,
      '--host',
      '127.0.0.1',
      '--client-metadata-url',
      CLIENT_METADATA_URL,
      '--silent',
    ],
    env: {
      MCP_REMOTE_CONFIG_DIR: configDir,
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    },
    stderr: 'pipe',
  });
}

async function runProxy() {
  const remote = new Client({ name: 'fnzsafe-binance-agentic-client', version: '0.1.0' });
  const transport = remoteTransport();
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await remote.connect(transport);

  const tools = (await listAllTools(remote)).filter((tool) => tool.name !== EXECUTE_TOOL_NAME);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const confirmed = process.env.FNZSAFE_BINANCE_USER_CONFIRMED === '1';
  const server = new Server(
    { name: 'fnzsafe-binance-agentic-gateway', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Binance Agentic MCP through FnzSafe. State-changing tools return a signed preview and require a later user message exactly equal to CONFIRM.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map((tool) => isReadOnlyTool(tool) ? tool : {
        ...tool,
        description: `PREVIEW ONLY. This call will not execute the action. It returns a five-minute preview token that can only be executed after the user's next message is exactly CONFIRM. ${text(tool.description)}`,
      }),
      {
        name: EXECUTE_TOOL_NAME,
        description: 'Execute one exact, unexpired Binance Agentic MCP preview. Use only after the user sends a new message exactly equal to CONFIRM. Never change the previewed arguments and never retry automatically.',
        inputSchema: {
          type: 'object',
          properties: { previewToken: { type: 'string', minLength: 64 } },
          required: ['previewToken'],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === EXECUTE_TOOL_NAME) {
      if (!confirmed) return jsonResult({ error: 'A real Binance Agentic action requires a new user message containing exactly CONFIRM.' }, true);
      try {
        const payload = decodePreviewToken(args.previewToken);
        const tool = toolsByName.get(payload.tool);
        if (!tool || isReadOnlyTool(tool)) throw new Error('previewed Binance Agentic tool is unavailable or no longer state-changing');
        await consumePreview(payload);
        return await remote.callTool({ name: payload.tool, arguments: payload.arguments });
      } catch (error) {
        return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    }

    const tool = toolsByName.get(name);
    if (!tool) return jsonResult({ error: `Unknown Binance Agentic tool: ${name}` }, true);
    if (isReadOnlyTool(tool)) return remote.callTool({ name, arguments: args });

    const previewToken = createPreviewToken(name, args);
    const preview = decodePreviewToken(previewToken);
    return jsonResult({
      source: 'Binance Agentic MCP',
      action: 'preview',
      tool: name,
      arguments: publicArguments(args),
      expiresInSeconds: PREVIEW_TTL_MS / 1000,
      expiresAt: new Date(preview.expiresAt).toISOString(),
      previewToken,
      confirmationRequired: 'CONFIRM',
    });
  });

  const localTransport = new StdioServerTransport();
  const close = async () => {
    await Promise.allSettled([server.close(), remote.close()]);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await server.connect(localTransport);
}

async function selfTest() {
  const secret = 'a'.repeat(32);
  const now = 1_000_000;
  const token = createPreviewToken('place_order', { symbol: 'BTCUSDT', apiKey: 'hidden' }, secret, now);
  const payload = decodePreviewToken(token, secret, now + 1);
  if (payload.tool !== 'place_order' || payload.arguments.symbol !== 'BTCUSDT') throw new Error('preview token round-trip failed');
  try {
    decodePreviewToken(`${token.slice(0, -1)}x`, secret, now + 1);
    throw new Error('tampered preview token was accepted');
  } catch (error) {
    if (error?.message === 'tampered preview token was accepted') throw error;
  }
  if (isReadOnlyTool({ name: 'place_order', annotations: { readOnlyHint: true } })) throw new Error('mutation-name safety fallback failed');
  if (isReadOnlyTool({ name: 'cancelOrder', annotations: { readOnlyHint: true } })) throw new Error('camel-case mutation-name safety fallback failed');
  if (isReadOnlyTool({ name: 'get_balance' })) throw new Error('unannotated tool was classified as read-only');
  if (!isReadOnlyTool({ name: 'get_balance', annotations: { readOnlyHint: true } })) throw new Error('read-only classification failed');
  if (publicArguments({ apiKey: 'hidden' }).apiKey !== '[REDACTED]') throw new Error('preview redaction failed');
  process.stdout.write(`${JSON.stringify({ ok: true, endpoint: AGENTIC_MCP_URL, executeTool: EXECUTE_TOOL_NAME })}\n`);
}

try {
  if (process.argv.includes('--self-test')) await selfTest();
  else await runProxy();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
