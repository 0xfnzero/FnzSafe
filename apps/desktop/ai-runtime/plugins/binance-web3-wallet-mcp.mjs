#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const execFileAsync = promisify(execFile);
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;
const CHAIN_IDS = ['56', '1', '8453', 'CT_501'];
const EVM_CHAIN_IDS = ['56', '1', '8453'];
const LIMIT_CHAIN_IDS = ['56', 'CT_501'];
const GAS_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/u;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u;
const SENSITIVE_KEY = /^(?:accessToken|apiKey|authorization|clientId|cookie|idToken|mnemonic|password|privateKey|refreshToken|secret|secretKey|seed|sessionId|signature)$/iu;

const text = (value) => String(value ?? '').trim();

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(redact(value)) }],
    ...(isError ? { isError: true } : {}),
  };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(nested),
  ]));
}

function requiredString(args, name, maxLength = 256) {
  const value = text(args?.[name]);
  if (!value) throw new Error(`${name} is required`);
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function optionalString(args, name, maxLength = 256) {
  const value = text(args?.[name]);
  if (!value) return '';
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function choice(value, name, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

function chainId(args, { limitOrder = false } = {}) {
  return choice(requiredString(args, 'chainId', 16), 'chainId', limitOrder ? LIMIT_CHAIN_IDS : CHAIN_IDS);
}

function decimal(args, name) {
  const value = requiredString(args, name, 40).replace(/^\$/u, '');
  if (!DECIMAL.test(value) || Number(value) <= 0) throw new Error(`${name} must be a positive decimal`);
  return value;
}

function tokenAddress(value, chain, name) {
  const address = text(value);
  const valid = chain === 'CT_501' ? SOLANA_ADDRESS.test(address) : EVM_ADDRESS.test(address);
  if (!valid) throw new Error(`${name} is invalid for chain ${chain}`);
  return address;
}

function slippage(args) {
  const value = args?.slippage ?? 'auto';
  if (value === 'auto') return 'auto';
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 5) throw new Error('slippage must be auto or greater than 0 and at most 5 percent');
  return String(number);
}

function gasLevel(args) {
  return choice(text(args?.gasLevel || 'MEDIUM').toUpperCase(), 'gasLevel', GAS_LEVELS);
}

function boolString(value, defaultValue = true) {
  if (value === undefined) return String(defaultValue);
  if (typeof value !== 'boolean') throw new Error('mev must be a boolean');
  return String(value);
}

function positiveInteger(args, name, defaultValue, max) {
  const value = args?.[name] ?? defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return value;
}

function bawEntryPath() {
  const packageJsonUrl = import.meta.resolve('@binance/agentic-wallet/package.json');
  return fileURLToPath(new URL('./dist/index.js', packageJsonUrl));
}

function walletDirectory() {
  const directory = text(process.env.FNZSAFE_BINANCE_WEB3_WALLET_DIR);
  if (!directory || !path.isAbsolute(directory)) throw new Error('Binance Agentic Wallet storage directory is invalid');
  return directory;
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
    // Prevent the CLI's keytar dependency from sharing its global `baw` session
    // with other applications; it then uses the isolated BINANCE_BAW_DIR file.
    const { stdout } = await execFileAsync(process.execPath, ['--no-addons', bawEntryPath(), ...args, '--json'], options);
    return parseCliJson(stdout);
  } catch (error) {
    if (text(error?.stdout)) return parseCliJson(error.stdout);
    if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('Binance Agentic Wallet request timed out');
    throw new Error(`Binance Agentic Wallet command failed: ${text(error?.message) || 'unknown error'}`);
  }
}

function previewSecret() {
  const secret = text(process.env.FNZSAFE_AGENTIC_PREVIEW_SECRET);
  if (secret.length < 32) throw new Error('FnzSafe Agentic preview secret is unavailable');
  return secret;
}

function sign(encoded, secret) {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

function createPreview(operation, parameters, secret = previewSecret(), now = Date.now()) {
  const payload = {
    v: 1,
    action: 'binance-web3-wallet',
    operation,
    parameters,
    expiresAt: now + PREVIEW_TTL_MS,
    nonce: randomBytes(16).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

function decodePreview(token, secret = previewSecret(), now = Date.now()) {
  const [encoded, signature, extra] = text(token).split('.');
  if (!encoded || !signature || extra !== undefined) throw new Error('invalid Binance Web3 preview token');
  const expected = Buffer.from(sign(encoded, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new Error('Binance Web3 preview token integrity check failed');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid Binance Web3 preview token payload');
  }
  if (!isRecord(payload)
    || payload.v !== 1
    || payload.action !== 'binance-web3-wallet'
    || typeof payload.operation !== 'string'
    || !isRecord(payload.parameters)
    || typeof payload.expiresAt !== 'number'
    || typeof payload.nonce !== 'string'
    || !/^[a-f0-9]{32}$/u.test(payload.nonce)) {
    throw new Error('invalid Binance Web3 preview token payload');
  }
  if (payload.expiresAt <= now || payload.expiresAt > now + PREVIEW_TTL_MS) throw new Error('Binance Web3 preview token expired');
  return payload;
}

async function consumePreview(payload) {
  const replayDirectory = path.join(walletDirectory(), 'fnzsafe-preview-replay');
  await fs.mkdir(replayDirectory, { recursive: true, mode: 0o700 });
  const marker = createHash('sha256').update(`${payload.expiresAt}:${payload.nonce}`).digest('hex');
  try {
    const handle = await fs.open(path.join(replayDirectory, `${payload.expiresAt}-${marker}`), 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Binance Web3 preview token was already consumed');
    throw error;
  }
}

function swapParameters(args) {
  const chain = chainId(args);
  return {
    chainId: chain,
    fromTokenQty: decimal(args, 'fromTokenQty'),
    fromToken: tokenAddress(args.fromToken, chain, 'fromToken'),
    toToken: tokenAddress(args.toToken, chain, 'toToken'),
    slippage: slippage(args),
    mev: boolString(args?.mev),
    gasLevel: gasLevel(args),
  };
}

function limitOrderParameters(args) {
  const chain = chainId(args, { limitOrder: true });
  return {
    side: choice(requiredString(args, 'side', 8).toLowerCase(), 'side', ['buy', 'sell']),
    chainId: chain,
    triggerPrice: decimal(args, 'triggerPrice'),
    fromTokenQty: decimal(args, 'fromTokenQty'),
    fromToken: tokenAddress(args.fromToken, chain, 'fromToken'),
    toToken: tokenAddress(args.toToken, chain, 'toToken'),
    slippage: slippage(args),
    mev: boolString(args?.mev),
    gasLevel: gasLevel(args),
  };
}

function sendParameters(args) {
  const chain = chainId(args);
  const sendMaximum = args?.max === true;
  if (args?.max !== undefined && typeof args.max !== 'boolean') throw new Error('max must be a boolean');
  const amount = text(args?.amount) ? decimal(args, 'amount') : '';
  if (sendMaximum === Boolean(amount)) throw new Error('provide exactly one of amount or max');
  return {
    chainId: chain,
    amount,
    max: sendMaximum,
    tokenAddress: tokenAddress(args?.tokenAddress, chain, 'tokenAddress'),
    recipient: tokenAddress(args?.recipient, chain, 'recipient'),
    gasLevel: gasLevel(args),
  };
}

function pendingTransactionParameters(args, { speedUp = false } = {}) {
  const txHash = requiredString(args, 'txHash', 66);
  if (!EVM_TX_HASH.test(txHash)) throw new Error('txHash must be a 32-byte EVM transaction hash');
  const requestedChain = optionalString(args, 'chainId', 16);
  const parameters = {
    txHash,
    ...(requestedChain ? { chainId: choice(requestedChain, 'chainId', EVM_CHAIN_IDS) } : {}),
  };
  if (speedUp) parameters.level = choice(text(args?.level || 'HIGH').toUpperCase(), 'level', ['LOW', 'HIGH']);
  return parameters;
}

function approvalParameters(args) {
  const chain = choice(requiredString(args, 'chainId', 16), 'chainId', EVM_CHAIN_IDS);
  return {
    chainId: chain,
    tokenContract: tokenAddress(args?.tokenContract, chain, 'tokenContract'),
    spender: tokenAddress(args?.spender, chain, 'spender'),
    type: choice(requiredString(args, 'type', 16).toLowerCase(), 'type', ['approve', 'permit2']),
  };
}

function swapArgs(parameters, command = 'swap') {
  return [
    'market-order', command,
    '--binanceChainId', parameters.chainId,
    '--fromTokenQty', parameters.fromTokenQty,
    '--fromToken', parameters.fromToken,
    '--toToken', parameters.toToken,
    '--slippage', parameters.slippage,
    ...(command === 'swap' ? ['--mev', parameters.mev, '--gasLevel', parameters.gasLevel] : []),
  ];
}

function limitArgs(parameters) {
  return [
    'limit-order', parameters.side,
    '--binanceChainId', parameters.chainId,
    '--triggerPrice', parameters.triggerPrice,
    '--fromTokenQty', parameters.fromTokenQty,
    '--fromToken', parameters.fromToken,
    '--toToken', parameters.toToken,
    '--slippage', parameters.slippage,
    '--mev', parameters.mev,
    '--gasLevel', parameters.gasLevel,
  ];
}

function sendArgs(parameters) {
  return [
    'wallet', 'send',
    '--binanceChainId', parameters.chainId,
    ...(parameters.max ? ['--max'] : ['--amount', parameters.amount]),
    '--tokenAddress', parameters.tokenAddress,
    '--recipient', parameters.recipient,
    '--gasLevel', parameters.gasLevel,
  ];
}

function pendingTransactionArgs(operation, parameters) {
  return [
    'wallet', operation, parameters.txHash,
    ...(operation === 'speed-up' ? ['--level', parameters.level] : []),
    ...(parameters.chainId ? ['--binanceChainId', parameters.chainId] : []),
  ];
}

function approvalArgs(operation, parameters) {
  return [
    'approvals', operation,
    '--binanceChainId', parameters.chainId,
    '--tokenContract', parameters.tokenContract,
    '--spender', parameters.spender,
    '--type', parameters.type,
  ];
}

function confirmation(args) {
  if (args?.confirmation !== 'CONFIRM' || process.env.FNZSAFE_BINANCE_USER_CONFIRMED !== '1') {
    throw new Error('A real Binance Web3 action requires a new user message containing exactly CONFIRM.');
  }
}

const chainProperty = { type: 'string', enum: CHAIN_IDS };
const evmChainProperty = { type: 'string', enum: EVM_CHAIN_IDS };
const tokenProperty = { type: 'string', minLength: 32, maxLength: 44 };
const evmAddressProperty = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const evmTxHashProperty = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
const decimalProperty = { type: 'string', minLength: 1, maxLength: 40 };
const tradingProperties = {
  chainId: chainProperty,
  fromTokenQty: decimalProperty,
  fromToken: tokenProperty,
  toToken: tokenProperty,
  slippage: { oneOf: [{ type: 'string', enum: ['auto'] }, { type: 'number', exclusiveMinimum: 0, maximum: 5 }] },
  mev: { type: 'boolean', default: true },
  gasLevel: { type: 'string', enum: GAS_LEVELS, default: 'MEDIUM' },
};

const tools = [
  { name: 'binance_web3_wallet_status', description: 'Check Binance Agentic Wallet sign-in and wallet creation status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_signin', description: 'Start Binance Agentic Wallet QR sign-in and return the official Binance URL and pairing details. This never asks for an API key or private key.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false } },
  { name: 'binance_web3_wallet_verify', description: 'Verify a Binance Agentic Wallet QR sign-in after the user approves it in the Binance App.', inputSchema: { type: 'object', properties: { qrCodeId: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['qrCodeId'], additionalProperties: false }, annotations: { readOnlyHint: false } },
  { name: 'binance_web3_wallet_signout_preview', description: 'Preview disconnecting the Binance Agentic Wallet session. This does not clear the session.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_signout_execute', description: 'Disconnect the Binance Agentic Wallet and clear its isolated local session. Requires a later user message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: true, readOnlyHint: false } },
  { name: 'binance_web3_wallet_chains', description: 'List chains supported by the connected Binance Agentic Wallet.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_addresses', description: 'Read the connected Binance Agentic Wallet addresses for supported chains.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_balance', description: 'Read non-zero Binance Agentic Wallet token balances and USD values.', inputSchema: { type: 'object', properties: { chainId: chainProperty, symbol: { type: 'string', minLength: 1, maxLength: 32 }, tokenAddress: tokenProperty }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_settings', description: 'Read Binance Agentic Wallet daily limit, tradable-token scope, and high-risk handling. Settings can only be changed in the Binance App.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_quota', description: 'Read current Binance Agentic Wallet daily trading-limit usage and remaining quota.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_history', description: 'Read Binance Agentic Wallet on-chain transaction history.', inputSchema: { type: 'object', properties: { chainId: chainProperty, type: { type: 'string', enum: ['all', 'pending', 'confirmed'] }, size: { type: 'integer', minimum: 1, maximum: 100 }, txHash: { type: 'string', minLength: 16, maxLength: 128 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_gas', description: 'Read current low, medium, and high gas-price estimates for one chain.', inputSchema: { type: 'object', properties: { chainId: chainProperty }, required: ['chainId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_wallet_transaction_lock', description: 'Read the Binance Agentic Wallet transaction-lock state for one chain before submitting another transaction.', inputSchema: { type: 'object', properties: { chainId: chainProperty }, required: ['chainId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_transaction_cancel_preview', description: 'Preview replacing one pending EVM transaction with a higher-gas cancellation. This does not broadcast a transaction.', inputSchema: { type: 'object', properties: { txHash: evmTxHashProperty, chainId: evmChainProperty }, required: ['txHash'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_transaction_cancel_execute', description: 'Broadcast one exact pending-transaction cancellation preview. Use only after the user sends a new message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_web3_transaction_speedup_preview', description: 'Preview replacing one pending EVM transaction with a higher-gas copy. This does not broadcast a transaction.', inputSchema: { type: 'object', properties: { txHash: evmTxHashProperty, chainId: evmChainProperty, level: { type: 'string', enum: ['LOW', 'HIGH'], default: 'HIGH' } }, required: ['txHash'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_transaction_speedup_execute', description: 'Broadcast one exact pending-transaction speed-up preview. Use only after the user sends a new message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_web3_approvals', description: 'List token approvals for the connected Binance Agentic Wallet, optionally filtered by spender or risk type.', inputSchema: { type: 'object', properties: { spender: evmAddressProperty, filterType: { type: 'string', enum: ['high_risk', 'medium_risk', 'non_interactive', 'others'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'string', minLength: 1, maxLength: 512 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_approval_detail', description: 'Read one EVM token approval and its recent operation records.', inputSchema: { type: 'object', properties: { chainId: evmChainProperty, tokenContract: evmAddressProperty, spender: evmAddressProperty, type: { type: 'string', enum: ['approve', 'permit2'] } }, required: ['chainId', 'tokenContract', 'spender', 'type'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_approval_revoke_preview', description: 'Preview revoking one exact EVM token approval. This does not broadcast a transaction.', inputSchema: { type: 'object', properties: { chainId: evmChainProperty, tokenContract: evmAddressProperty, spender: evmAddressProperty, type: { type: 'string', enum: ['approve', 'permit2'] } }, required: ['chainId', 'tokenContract', 'spender', 'type'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_approval_revoke_execute', description: 'Broadcast one exact token-approval revocation preview. Use only after the user sends a new message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_web3_transfer_preview', description: 'Create a five-minute, integrity-bound preview for an exact Binance Agentic Wallet token transfer. This does not send tokens.', inputSchema: { type: 'object', properties: { chainId: chainProperty, amount: decimalProperty, max: { type: 'boolean', default: false }, tokenAddress: tokenProperty, recipient: tokenProperty, gasLevel: { type: 'string', enum: GAS_LEVELS, default: 'MEDIUM' } }, required: ['chainId', 'tokenAddress', 'recipient'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_transfer_execute', description: 'Execute one exact Binance Agentic Wallet token-transfer preview. Use only after the user sends a new message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_web3_swap_quote', description: 'Get a Binance Agentic Wallet DEX swap quote without trading.', inputSchema: { type: 'object', properties: tradingProperties, required: ['chainId', 'fromTokenQty', 'fromToken', 'toToken'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_swap_preview', description: 'Create a five-minute, integrity-bound preview for an exact Binance Agentic Wallet market swap. This does not trade.', inputSchema: { type: 'object', properties: tradingProperties, required: ['chainId', 'fromTokenQty', 'fromToken', 'toToken'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_swap_execute', description: 'Execute one exact Binance Agentic Wallet swap preview. Use only after the user sends a new message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_web3_market_orders', description: 'List or query Binance Agentic Wallet market swap orders.', inputSchema: { type: 'object', properties: { orderId: { type: 'string', minLength: 1, maxLength: 64 }, chainId: chainProperty, status: { type: 'string', enum: ['PENDING', 'FINISHED', 'FAILED'] }, page: { type: 'integer', minimum: 1, maximum: 10000 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_limit_order_preview', description: 'Create a five-minute, integrity-bound preview for an exact BSC or Solana Binance Agentic Wallet limit order. This does not place an order.', inputSchema: { type: 'object', properties: { ...tradingProperties, chainId: { type: 'string', enum: LIMIT_CHAIN_IDS }, side: { type: 'string', enum: ['buy', 'sell'] }, triggerPrice: decimalProperty }, required: ['side', 'chainId', 'triggerPrice', 'fromTokenQty', 'fromToken', 'toToken'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_limit_order_execute', description: 'Place one exact Binance Agentic Wallet limit-order preview. Use only after the user sends a new message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_web3_limit_orders', description: 'List or query Binance Agentic Wallet BSC or Solana limit orders.', inputSchema: { type: 'object', properties: { strategyId: { type: 'string', minLength: 1, maxLength: 64 }, chainId: { type: 'string', enum: LIMIT_CHAIN_IDS }, status: { type: 'string', enum: ['PENDING', 'WORKING', 'TRIGGERED', 'FINISHED', 'FAILED', 'EXPIRED', 'CANCELED'] }, page: { type: 'integer', minimum: 1, maximum: 10000 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_limit_cancel_preview', description: 'Preview cancellation of one Binance Agentic Wallet limit order. This does not cancel it.', inputSchema: { type: 'object', properties: { strategyId: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['strategyId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_web3_limit_cancel_execute', description: 'Cancel one exact Binance Agentic Wallet limit-order preview. Use only after the user sends a new message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: { previewToken: { type: 'string', minLength: 64 }, confirmation: { type: 'string', enum: ['CONFIRM'] } }, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
];

function appendOption(command, name, value) {
  if (value !== '' && value !== undefined) command.push(name, String(value));
}

async function handleTool(name, args) {
  switch (name) {
    case 'binance_web3_wallet_status': return runBaw(['wallet', 'status']);
    case 'binance_web3_wallet_signin': return runBaw(['auth', 'signin']);
    case 'binance_web3_wallet_verify': return runBaw(['auth', 'verify', '--qrCodeId', requiredString(args, 'qrCodeId', 256)], WRITE_TIMEOUT_MS);
    case 'binance_web3_wallet_signout_preview': {
      const status = await runBaw(['wallet', 'status']);
      const previewToken = createPreview('signout', {});
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'signout', status, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_wallet_chains': return runBaw(['wallet', 'chains']);
    case 'binance_web3_wallet_addresses': return runBaw(['wallet', 'address']);
    case 'binance_web3_wallet_settings': return runBaw(['wallet', 'settings']);
    case 'binance_web3_wallet_quota': return runBaw(['wallet', 'left-quota']);
    case 'binance_web3_wallet_gas': return runBaw(['wallet', 'gas-price', '--binanceChainId', chainId(args)]);
    case 'binance_web3_wallet_transaction_lock': return runBaw(['wallet', 'tx-lock', '--binanceChainId', chainId(args)]);
    case 'binance_web3_transaction_cancel_preview': {
      const parameters = pendingTransactionParameters(args);
      const transaction = await runBaw(['wallet', 'tx-history', '--tx', parameters.txHash]);
      if (transaction?.success === false) return transaction;
      const previewToken = createPreview('transaction-cancel', parameters);
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'transaction-cancel', parameters, transaction, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_transaction_speedup_preview': {
      const parameters = pendingTransactionParameters(args, { speedUp: true });
      const transaction = await runBaw(['wallet', 'tx-history', '--tx', parameters.txHash]);
      if (transaction?.success === false) return transaction;
      const previewToken = createPreview('transaction-speedup', parameters);
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'transaction-speedup', parameters, transaction, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_approvals': {
      const command = ['approvals', 'list'];
      const spender = optionalString(args, 'spender', 42);
      if (spender) appendOption(command, '--spender', tokenAddress(spender, '1', 'spender'));
      const filterType = optionalString(args, 'filterType', 32);
      if (filterType) appendOption(command, '--filterTypes', choice(filterType, 'filterType', ['high_risk', 'medium_risk', 'non_interactive', 'others']));
      if (args?.limit !== undefined) appendOption(command, '--limit', positiveInteger(args, 'limit', 20, 100));
      appendOption(command, '--offset', optionalString(args, 'offset', 512));
      return runBaw(command);
    }
    case 'binance_web3_approval_detail': return runBaw(approvalArgs('detail', approvalParameters(args)));
    case 'binance_web3_approval_revoke_preview': {
      const parameters = approvalParameters(args);
      const approval = await runBaw(approvalArgs('detail', parameters));
      if (approval?.success === false) return approval;
      const previewToken = createPreview('approval-revoke', parameters);
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'approval-revoke', parameters, approval, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_wallet_balance': {
      const command = ['wallet', 'balance'];
      const chain = optionalString(args, 'chainId', 16);
      if (chain) appendOption(command, '--binanceChainId', choice(chain, 'chainId', CHAIN_IDS));
      appendOption(command, '--symbol', optionalString(args, 'symbol', 32));
      const address = optionalString(args, 'tokenAddress', 44);
      if (address) appendOption(command, '--tokenAddress', chain ? tokenAddress(address, chain, 'tokenAddress') : address);
      return runBaw(command);
    }
    case 'binance_web3_wallet_history': {
      const command = ['wallet', 'tx-history'];
      const chain = optionalString(args, 'chainId', 16);
      if (chain) appendOption(command, '--binanceChainId', choice(chain, 'chainId', CHAIN_IDS));
      const type = optionalString(args, 'type', 16);
      if (type) appendOption(command, '--type', choice(type, 'type', ['all', 'pending', 'confirmed']));
      if (args?.size !== undefined) appendOption(command, '--size', positiveInteger(args, 'size', 20, 100));
      appendOption(command, '--tx', optionalString(args, 'txHash', 128));
      return runBaw(command);
    }
    case 'binance_web3_swap_quote': {
      const parameters = swapParameters(args);
      return runBaw(swapArgs(parameters, 'quote'));
    }
    case 'binance_web3_transfer_preview': {
      const parameters = sendParameters(args);
      const [balance, gas] = await Promise.all([
        runBaw(['wallet', 'balance', '--binanceChainId', parameters.chainId, '--tokenAddress', parameters.tokenAddress]),
        runBaw(['wallet', 'gas-price', '--binanceChainId', parameters.chainId]),
      ]);
      if (balance?.success === false) return balance;
      if (gas?.success === false) return gas;
      const previewToken = createPreview('transfer', parameters);
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'transfer', parameters, balance, gas, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_swap_preview': {
      const parameters = swapParameters(args);
      const quote = await runBaw(swapArgs(parameters, 'quote'));
      if (quote?.success === false) return quote;
      const previewToken = createPreview('swap', parameters);
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'swap', parameters, quote, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_market_orders': {
      const command = ['market-order', 'list'];
      appendOption(command, '--orderId', optionalString(args, 'orderId', 64));
      const chain = optionalString(args, 'chainId', 16);
      if (chain) appendOption(command, '--binanceChainId', choice(chain, 'chainId', CHAIN_IDS));
      const status = optionalString(args, 'status', 16);
      if (status) appendOption(command, '--status', choice(status, 'status', ['PENDING', 'FINISHED', 'FAILED']));
      if (args?.page !== undefined) appendOption(command, '--page', positiveInteger(args, 'page', 1, 10000));
      if (args?.pageSize !== undefined) appendOption(command, '--pageSize', positiveInteger(args, 'pageSize', 20, 100));
      return runBaw(command);
    }
    case 'binance_web3_limit_order_preview': {
      const parameters = limitOrderParameters(args);
      const quota = await runBaw(['wallet', 'left-quota']);
      if (quota?.success === false) return quota;
      const previewToken = createPreview('limit-order', parameters);
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'limit-order', parameters, quota, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_limit_orders': {
      const command = ['limit-order', 'list'];
      appendOption(command, '--strategyId', optionalString(args, 'strategyId', 64));
      const chain = optionalString(args, 'chainId', 16);
      if (chain) appendOption(command, '--binanceChainId', choice(chain, 'chainId', LIMIT_CHAIN_IDS));
      const status = optionalString(args, 'status', 16);
      if (status) appendOption(command, '--status', choice(status, 'status', ['PENDING', 'WORKING', 'TRIGGERED', 'FINISHED', 'FAILED', 'EXPIRED', 'CANCELED']));
      if (args?.page !== undefined) appendOption(command, '--page', positiveInteger(args, 'page', 1, 10000));
      if (args?.pageSize !== undefined) appendOption(command, '--pageSize', positiveInteger(args, 'pageSize', 20, 100));
      return runBaw(command);
    }
    case 'binance_web3_limit_cancel_preview': {
      const strategyId = requiredString(args, 'strategyId', 64);
      const order = await runBaw(['limit-order', 'list', '--strategyId', strategyId]);
      if (order?.success === false) return order;
      const parameters = { strategyId };
      const previewToken = createPreview('limit-cancel', parameters);
      const preview = decodePreview(previewToken);
      return { action: 'preview', operation: 'limit-cancel', parameters, order, expiresAt: new Date(preview.expiresAt).toISOString(), previewToken, confirmationRequired: 'CONFIRM' };
    }
    case 'binance_web3_swap_execute':
    case 'binance_web3_limit_order_execute':
    case 'binance_web3_limit_cancel_execute':
    case 'binance_web3_transfer_execute':
    case 'binance_web3_transaction_cancel_execute':
    case 'binance_web3_transaction_speedup_execute':
    case 'binance_web3_approval_revoke_execute':
    case 'binance_web3_wallet_signout_execute': {
      confirmation(args);
      const preview = decodePreview(requiredString(args, 'previewToken', 16_384));
      let expected = 'limit-cancel';
      if (name === 'binance_web3_swap_execute') expected = 'swap';
      else if (name === 'binance_web3_limit_order_execute') expected = 'limit-order';
      else if (name === 'binance_web3_transfer_execute') expected = 'transfer';
      else if (name === 'binance_web3_transaction_cancel_execute') expected = 'transaction-cancel';
      else if (name === 'binance_web3_transaction_speedup_execute') expected = 'transaction-speedup';
      else if (name === 'binance_web3_approval_revoke_execute') expected = 'approval-revoke';
      else if (name === 'binance_web3_wallet_signout_execute') expected = 'signout';
      if (preview.operation !== expected) throw new Error(`preview operation must be ${expected}`);
      await consumePreview(preview);
      if (expected === 'swap') return runBaw(swapArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'limit-order') return runBaw(limitArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'transfer') return runBaw(sendArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'transaction-cancel') return runBaw(pendingTransactionArgs('cancel', preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'transaction-speedup') return runBaw(pendingTransactionArgs('speed-up', preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'approval-revoke') return runBaw(approvalArgs('revoke', preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'signout') return runBaw(['auth', 'signout'], WRITE_TIMEOUT_MS);
      return runBaw(['limit-order', 'cancel', '--strategyId', requiredString(preview.parameters, 'strategyId', 64)], WRITE_TIMEOUT_MS);
    }
    default: throw new Error(`Unknown Binance Web3 tool: ${name}`);
  }
}

async function runServer() {
  const server = new Server(
    { name: 'fnzsafe-binance-web3-wallet', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'Binance Agentic Wallet through FnzSafe. Every write requires a signed preview and a later user message exactly equal to CONFIRM.' },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await handleTool(request.params.name, request.params.arguments || {});
      return jsonResult(result, result?.success === false);
    } catch (error) {
      return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  });
  await server.connect(new StdioServerTransport());
}

async function selfTest() {
  await fs.access(bawEntryPath());
  const { stdout } = await execFileAsync(process.execPath, ['--no-addons', bawEntryPath(), '--version'], { timeout: 10_000 });
  if (!/^1\.10\./u.test(text(stdout))) throw new Error(`unexpected Binance Agentic Wallet CLI version: ${text(stdout)}`);
  const secret = 'a'.repeat(32);
  const now = 1_000_000;
  const token = createPreview('swap', { chainId: '56' }, secret, now);
  const preview = decodePreview(token, secret, now + 1);
  if (preview.operation !== 'swap' || preview.parameters.chainId !== '56') throw new Error('Binance Web3 preview round-trip failed');
  const parameters = swapParameters({
    chainId: '56',
    fromTokenQty: '1.5',
    fromToken: '0x55d398326f99059fF775485246999027B3197955',
    toToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    slippage: 1,
  });
  if (!swapArgs(parameters).includes('--gasLevel')) throw new Error('Binance Web3 command construction failed');
  const transfer = sendParameters({
    chainId: '56', amount: '2.5', tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    recipient: '0x0000000000000000000000000000000000000001', gasLevel: 'LOW',
  });
  if (!sendArgs(transfer).includes('--recipient')) throw new Error('Binance Web3 transfer command construction failed');
  const replacement = pendingTransactionParameters({ txHash: `0x${'1'.repeat(64)}`, chainId: '1', level: 'low' }, { speedUp: true });
  if (!pendingTransactionArgs('speed-up', replacement).includes('LOW')) throw new Error('Binance Web3 speed-up command construction failed');
  const approval = approvalParameters({ chainId: '56', tokenContract: `0x${'2'.repeat(40)}`, spender: `0x${'3'.repeat(40)}`, type: 'permit2' });
  if (!approvalArgs('revoke', approval).includes('permit2')) throw new Error('Binance Web3 approval command construction failed');
  if (!tools.some((tool) => tool.name === 'binance_web3_approval_revoke_execute')) throw new Error('Binance Web3 approval tools are missing');
  try {
    pendingTransactionParameters({ txHash: `0x${'1'.repeat(64)}`, chainId: 'CT_501' });
    throw new Error('Solana replacement transaction was accepted');
  } catch (error) {
    if (error?.message === 'Solana replacement transaction was accepted') throw error;
  }
  try {
    swapParameters({ ...parameters, slippage: 6 });
    throw new Error('unsafe Binance Web3 slippage was accepted');
  } catch (error) {
    if (error?.message === 'unsafe Binance Web3 slippage was accepted') throw error;
  }
  const redacted = redact({ accessToken: 'secret', sessionId: 'secret', previewToken: 'keep' });
  if (redacted.accessToken !== '[REDACTED]' || redacted.sessionId !== '[REDACTED]' || redacted.previewToken !== 'keep') {
    throw new Error('Binance Web3 sensitive-field redaction failed');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, cliVersion: text(stdout), tools: tools.map((tool) => tool.name) })}\n`);
}

try {
  if (process.argv.includes('--self-test')) await selfTest();
  else await runServer();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
