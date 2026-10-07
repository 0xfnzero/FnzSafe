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
const MAX_PREVIEW_TOKEN_LENGTH = 1024 * 1024;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;
const CHAIN_IDS = ['56', '1', '8453', 'CT_501'];
const EVM_CHAIN_IDS = ['56', '1', '8453'];
const LIMIT_CHAIN_IDS = ['56', 'CT_501'];
const PREDICTION_CHAIN_IDS = ['56', '137'];
const GAS_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/u;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u;
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/u;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/u;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;
const WEI_VALUE = /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/u;
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

function boundedInteger(args, name, { defaultValue, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = args?.[name] ?? defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function identifier(args, name, maxLength = 128) {
  const value = requiredString(args, name, maxLength);
  if (!IDENTIFIER.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

function optionalIdentifier(args, name, maxLength = 128) {
  const value = optionalString(args, name, maxLength);
  if (value && !IDENTIFIER.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

function identifierList(args, name, maxItems = 20) {
  const raw = requiredString(args, name, maxItems * 129);
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.length > maxItems || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain 1 to ${maxItems} unique IDs`);
  }
  for (const value of values) {
    if (value.length > 128 || !IDENTIFIER.test(value)) throw new Error(`${name} contains an invalid ID`);
  }
  return values.join(',');
}

function ratio(args, name = 'ratio') {
  const value = decimal(args, name);
  if (Number(value) > 1) throw new Error(`${name} must be greater than 0 and at most 1`);
  return value;
}

function slippageBps(args, { optional = false } = {}) {
  const value = text(args?.slippageBps);
  if (!value && optional) return '';
  if (!value || !/^[0-9]+$/u.test(value) || Number(value) < 1 || Number(value) > 4999) {
    throw new Error('slippageBps must be an integer from 1 to 4999');
  }
  return String(Number(value));
}

function defiSlippageBps(args) {
  const value = text(args?.slippageBps || 'auto');
  return value === 'auto' ? value : slippageBps({ slippageBps: value });
}

function optionalChainId(args, allowed = CHAIN_IDS) {
  const value = optionalString(args, 'chainId', 16);
  return value ? choice(value, 'chainId', allowed) : '';
}

function addressForKnownChain(value, chain, name) {
  const address = text(value);
  if (chain) return tokenAddress(address, chain, name);
  if (!EVM_ADDRESS.test(address) && !SOLANA_ADDRESS.test(address)) throw new Error(`${name} is invalid`);
  return address;
}

function jsonDepth(value, depth = 0) {
  if (depth > 24) throw new Error('JSON payload is too deeply nested');
  if (Array.isArray(value)) {
    for (const entry of value) jsonDepth(entry, depth + 1);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) jsonDepth(entry, depth + 1);
  }
}

function canonicalJson(raw, name, maxBytes = 65_536) {
  const source = requiredString({ [name]: raw }, name, maxBytes);
  if (Buffer.byteLength(source, 'utf8') > maxBytes) throw new Error(`${name} is too large`);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${name} must be a JSON object`);
  jsonDepth(parsed);
  return JSON.stringify(parsed);
}

function paymentRequirements(args) {
  const source = requiredString(args, 'paymentRequirements', 131_072);
  let decoded = source;
  if (!source.trimStart().startsWith('{')) {
    if (!/^[A-Za-z0-9+/=_-]+$/u.test(source)) throw new Error('paymentRequirements must be JSON or base64 JSON');
    try {
      decoded = Buffer.from(source, 'base64').toString('utf8');
    } catch {
      throw new Error('paymentRequirements must be JSON or base64 JSON');
    }
  }
  return canonicalJson(decoded, 'paymentRequirements');
}

function eip712Message(args) {
  const message = canonicalJson(requiredString(args, 'message', 65_536), 'message');
  const parsed = JSON.parse(message);
  if (parsed.method !== 'eth_signTypedData_v4' || !Array.isArray(parsed.params) || parsed.params.length !== 2) {
    throw new Error('message must be an eth_signTypedData_v4 JSON-RPC wrapper with two params');
  }
  const typedData = typeof parsed.params[1] === 'string' ? (() => {
    try { return JSON.parse(parsed.params[1]); } catch { return null; }
  })() : parsed.params[1];
  if (!isRecord(typedData) || !isRecord(typedData.types) || !isRecord(typedData.domain) || !text(typedData.primaryType)) {
    throw new Error('message contains invalid EIP-712 typed data');
  }
  jsonDepth(typedData);
  return message;
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

function predictionQuoteParameters(args) {
  const orderType = choice(requiredString(args, 'orderType', 16).toUpperCase(), 'orderType', ['MARKET', 'LIMIT']);
  const priceLimit = optionalString(args, 'priceLimit', 40);
  if ((orderType === 'LIMIT') !== Boolean(priceLimit)) throw new Error('priceLimit is required only for LIMIT orders');
  return {
    chainId: choice(requiredString(args, 'chainId', 16), 'chainId', PREDICTION_CHAIN_IDS),
    tokenId: identifier(args, 'tokenId'),
    marketTopicId: identifier(args, 'marketTopicId'),
    side: choice(requiredString(args, 'side', 8).toUpperCase(), 'side', ['BUY', 'SELL']),
    amount: decimal(args, 'amount'),
    orderType,
    slippageBps: slippageBps(args, { optional: true }),
    priceLimit: priceLimit ? decimal({ priceLimit }, 'priceLimit') : '',
  };
}

function predictionPlaceParameters(args) {
  const orderType = choice(text(args?.orderType || 'MARKET').toUpperCase(), 'orderType', ['MARKET', 'LIMIT']);
  const priceLimit = optionalString(args, 'priceLimit', 40);
  if ((orderType === 'LIMIT') !== Boolean(priceLimit)) throw new Error('priceLimit is required only for LIMIT orders');
  return {
    quoteId: identifier(args, 'quoteId'),
    orderType,
    slippageBps: slippageBps(args),
    priceLimit: priceLimit ? decimal({ priceLimit }, 'priceLimit') : '',
  };
}

function predictionQuoteArgs(parameters) {
  const command = [
    'prediction', 'trade', 'quote',
    '--binanceChainId', parameters.chainId,
    '--tokenId', parameters.tokenId,
    '--marketTopicId', parameters.marketTopicId,
    '--side', parameters.side,
    '--amount', parameters.amount,
    '--orderType', parameters.orderType,
  ];
  appendOption(command, '--slippageBps', parameters.slippageBps);
  appendOption(command, '--priceLimit', parameters.priceLimit);
  return command;
}

function predictionPlaceArgs(parameters) {
  const command = [
    'prediction', 'trade', 'place-order',
    '--quoteId', parameters.quoteId,
    '--orderType', parameters.orderType,
    '--slippageBps', parameters.slippageBps,
  ];
  appendOption(command, '--priceLimit', parameters.priceLimit);
  return command;
}

function defiChain(args) {
  return choice(text(args?.chainId || '56'), 'chainId', CHAIN_IDS);
}

function defiActionParameters(args, forcedAction = '') {
  const action = forcedAction || choice(requiredString(args, 'action', 16), 'action', ['deposit', 'redeem', 'lp-add', 'lp-remove', 'claim']);
  const chain = defiChain(args);
  const parameters = { action, chainId: chain, gasLevel: gasLevel(args) };
  if (action !== 'claim' || text(args?.investmentId)) parameters.investmentId = identifier(args, 'investmentId');
  const rawTokenAddress = optionalString(args, 'tokenAddress', 44);
  if (rawTokenAddress) parameters.tokenAddress = tokenAddress(rawTokenAddress, chain, 'tokenAddress');

  if (action === 'deposit') {
    if (!parameters.tokenAddress) throw new Error('tokenAddress is required');
    parameters.amount = decimal(args, 'amount');
  } else if (action === 'redeem') {
    if (!parameters.tokenAddress) throw new Error('tokenAddress is required');
    const amount = optionalString(args, 'amount', 40);
    const rawRatio = optionalString(args, 'ratio', 40);
    if (Boolean(amount) === Boolean(rawRatio)) throw new Error('provide exactly one of amount or ratio');
    if (amount) parameters.amount = decimal({ amount }, 'amount');
    else parameters.ratio = ratio({ ratio: rawRatio });
  } else if (action === 'lp-add') {
    if (!parameters.tokenAddress) throw new Error('tokenAddress is required');
    parameters.amount = decimal(args, 'amount');
    parameters.slippageBps = defiSlippageBps(args);
    const nftId = optionalIdentifier(args, 'nftId');
    const priceRange = optionalString(args, 'priceRange', 40);
    const tickLower = optionalString(args, 'tickLower', 16);
    const tickUpper = optionalString(args, 'tickUpper', 16);
    const hasTicks = Boolean(tickLower || tickUpper);
    if (hasTicks && (!tickLower || !tickUpper)) throw new Error('tickLower and tickUpper must be provided together');
    if ([Boolean(nftId), Boolean(priceRange), hasTicks].filter(Boolean).length !== 1) {
      throw new Error('provide exactly one LP source: nftId, priceRange, or tickLower with tickUpper');
    }
    if (nftId) parameters.nftId = nftId;
    if (priceRange) {
      parameters.priceRange = decimal({ priceRange }, 'priceRange');
      if (Number(parameters.priceRange) > 50) throw new Error('priceRange must be greater than 0 and at most 50');
    }
    if (hasTicks) {
      if (!INTEGER.test(tickLower) || !INTEGER.test(tickUpper)) throw new Error('ticks must be integers');
      const lower = Number(tickLower);
      const upper = Number(tickUpper);
      if (lower < -887272 || upper > 887272 || lower >= upper) throw new Error('ticks must be ordered int24 values within the supported range');
      parameters.tickLower = tickLower;
      parameters.tickUpper = tickUpper;
    }
  } else if (action === 'lp-remove') {
    parameters.nftId = identifier(args, 'nftId');
    parameters.ratio = ratio(args);
    parameters.slippageBps = defiSlippageBps(args);
  } else {
    parameters.claimType = choice(requiredString(args, 'claimType', 32), 'claimType', ['REWARD_PROTOCOL', 'REWARD_INVESTMENT', 'LP_FEE', 'REDEMPTION']);
    if (parameters.claimType === 'REWARD_PROTOCOL') parameters.defiProtocolId = identifier(args, 'defiProtocolId');
    if (parameters.claimType === 'REWARD_INVESTMENT' && !parameters.investmentId) throw new Error('investmentId is required');
    if (parameters.claimType === 'LP_FEE') {
      if (!parameters.investmentId) throw new Error('investmentId is required');
      parameters.nftId = identifier(args, 'nftId');
    }
    if (parameters.claimType === 'REDEMPTION') {
      if (!parameters.investmentId) throw new Error('investmentId is required');
      parameters.redemptionId = identifier(args, 'redemptionId');
    }
  }
  return parameters;
}

function defiArgs(parameters, preview = false) {
  const command = ['defi', preview ? 'preview' : parameters.action];
  if (preview) command.push('--action', parameters.action);
  for (const [key, value] of Object.entries(parameters)) {
    if (key === 'action') continue;
    const option = key === 'chainId' ? '--binanceChainId' : `--${key}`;
    appendOption(command, option, value);
  }
  return command;
}

function base64Transaction(args) {
  const value = requiredString(args, 'unsignedTx', 350_000);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('unsignedTx must be canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > 256 * 1024) throw new Error('unsignedTx must decode to 1-262144 bytes');
  return value;
}

function contractCallParameters(args) {
  const chain = chainId(args);
  const from = tokenAddress(args?.from, chain, 'from');
  if (chain === 'CT_501') {
    if (text(args?.to) || text(args?.value) || text(args?.inputData) || args?.gasLimit !== undefined) {
      throw new Error('Solana contract calls accept only from and unsignedTx');
    }
    return { chainId: chain, from, unsignedTx: base64Transaction(args) };
  }
  if (text(args?.unsignedTx)) throw new Error('EVM contract calls do not accept unsignedTx');
  const value = optionalString(args, 'value', 80);
  if (value && !WEI_VALUE.test(value)) throw new Error('value must be a non-negative integer or 0x-prefixed hex integer');
  const inputData = optionalString(args, 'inputData', 524_290) || '0x';
  if (!HEX_DATA.test(inputData)) throw new Error('inputData must be 0x-prefixed, even-length hexadecimal data');
  const parameters = {
    chainId: chain,
    from,
    to: tokenAddress(args?.to, chain, 'to'),
    value,
    inputData,
  };
  if (args?.gasLimit !== undefined) parameters.gasLimit = boundedInteger(args, 'gasLimit', { min: 21_000, max: 15_000_000 });
  return parameters;
}

function contractCallArgs(parameters) {
  const command = ['contract-call', 'preview', '--binanceChainId', parameters.chainId, '--from', parameters.from];
  appendOption(command, '--to', parameters.to);
  appendOption(command, '--value', parameters.value);
  appendOption(command, '--inputData', parameters.inputData);
  appendOption(command, '--unsignedTx', parameters.unsignedTx);
  appendOption(command, '--gasLimit', parameters.gasLimit);
  return command;
}

function signMessageParameters(args) {
  const chain = choice(requiredString(args, 'chainId', 16), 'chainId', EVM_CHAIN_IDS);
  const message = eip712Message(args);
  const parsed = JSON.parse(message);
  if (!EVM_ADDRESS.test(text(parsed.params[0]))) throw new Error('the first EIP-712 param must be an EVM signer address');
  const typedData = typeof parsed.params[1] === 'string' ? JSON.parse(parsed.params[1]) : parsed.params[1];
  const domainChain = typedData.domain.chainId;
  if (domainChain !== undefined) {
    const parsedChain = typeof domainChain === 'string' && domainChain.startsWith('0x')
      ? Number.parseInt(domainChain, 16)
      : Number(domainChain);
    if (!Number.isSafeInteger(parsedChain) || String(parsedChain) !== chain) throw new Error('EIP-712 domain chainId must match chainId');
  }
  return { chainId: chain, message, signType: 'EIP712' };
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

function previewResult(operation, parameters, evidence = {}) {
  const previewToken = createPreview(operation, parameters);
  const preview = decodePreview(previewToken);
  return {
    action: 'preview',
    operation,
    parameters,
    ...evidence,
    expiresAt: new Date(preview.expiresAt).toISOString(),
    previewToken,
    confirmationRequired: 'CONFIRM',
  };
}

const chainProperty = { type: 'string', enum: CHAIN_IDS };
const evmChainProperty = { type: 'string', enum: EVM_CHAIN_IDS };
const tokenProperty = { type: 'string', minLength: 32, maxLength: 44 };
const evmAddressProperty = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const evmTxHashProperty = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
const decimalProperty = { type: 'string', minLength: 1, maxLength: 40 };
const identifierProperty = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' };
const offsetProperty = { type: 'integer', minimum: 0, maximum: 1_000_000 };
const pageLimitProperty = { type: 'integer', minimum: 1, maximum: 100 };
const executionProperties = {
  previewToken: { type: 'string', minLength: 64, maxLength: MAX_PREVIEW_TOKEN_LENGTH },
  confirmation: { type: 'string', enum: ['CONFIRM'] },
};
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
  { name: 'binance_prediction_market_list', description: 'List Binance prediction markets with optional category and sort filters.', inputSchema: { type: 'object', properties: { l1Category: identifierProperty, l2Category: identifierProperty, sortBy: { type: 'string', enum: ['RECOMMENDED', 'VOLUME', 'PARTICIPANTS', 'CREATED_TIME', 'END_DATE'] }, orderBy: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' }, offset: offsetProperty, limit: pageLimitProperty }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_market_detail', description: 'Read one Binance prediction market topic and its outcome market IDs.', inputSchema: { type: 'object', properties: { marketTopicId: identifierProperty }, required: ['marketTopicId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_market_search', description: 'Search Binance prediction markets by keyword.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_order_book', description: 'Read the order book for one prediction outcome token.', inputSchema: { type: 'object', properties: { marketId: identifierProperty, tokenId: identifierProperty }, required: ['marketId', 'tokenId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_last_trade_price', description: 'Read the last trade price for one prediction sub-market.', inputSchema: { type: 'object', properties: { marketId: identifierProperty }, required: ['marketId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_categories', description: 'List Binance prediction market categories.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_positions', description: 'List current Binance prediction positions and PnL summaries.', inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['ONGOING', 'ENDED', 'PENDING_CLAIM'], default: 'ONGOING' }, offset: offsetProperty, limit: pageLimitProperty }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_position', description: 'Read one Binance prediction position by outcome token ID.', inputSchema: { type: 'object', properties: { tokenId: identifierProperty }, required: ['tokenId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_settled_history', description: 'List settled Binance prediction positions.', inputSchema: { type: 'object', properties: { l1Category: identifierProperty, filter: { type: 'string', enum: ['all', 'win', 'lose'], default: 'all' }, offset: offsetProperty, limit: pageLimitProperty }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_pnl', description: 'Query Binance prediction PnL records.', inputSchema: { type: 'object', properties: { tokenId: identifierProperty, l1Category: identifierProperty, offset: offsetProperty, limit: pageLimitProperty }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_portfolio', description: 'Read the connected Binance prediction portfolio summary.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_order_history', description: 'List Binance prediction orders with status and type filters.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'FAILED', 'EXPIRED'] }, l1Category: identifierProperty, orderType: { type: 'string', enum: ['MARKET', 'LIMIT'] }, offset: offsetProperty, limit: pageLimitProperty }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_trade_quote', description: 'Get a non-binding prediction trade quote on BSC or Polygon.', inputSchema: { type: 'object', properties: { chainId: { type: 'string', enum: PREDICTION_CHAIN_IDS }, tokenId: identifierProperty, marketTopicId: identifierProperty, side: { type: 'string', enum: ['BUY', 'SELL'] }, amount: decimalProperty, orderType: { type: 'string', enum: ['MARKET', 'LIMIT'] }, slippageBps: { type: 'integer', minimum: 1, maximum: 4999 }, priceLimit: decimalProperty }, required: ['chainId', 'tokenId', 'marketTopicId', 'side', 'amount', 'orderType'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_trade_place_preview', description: 'Create a five-minute FnzSafe preview for placing one exact prediction quote. This does not place the order.', inputSchema: { type: 'object', properties: { quoteId: identifierProperty, orderType: { type: 'string', enum: ['MARKET', 'LIMIT'], default: 'MARKET' }, slippageBps: { type: 'integer', minimum: 1, maximum: 4999 }, priceLimit: decimalProperty }, required: ['quoteId', 'slippageBps'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_trade_place_execute', description: 'Place one exact prediction order preview after a later user message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: executionProperties, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_prediction_trade_cancel_preview', description: 'Create a five-minute FnzSafe preview for cancelling up to 20 exact prediction order IDs.', inputSchema: { type: 'object', properties: { orderIds: { type: 'string', minLength: 1, maxLength: 2580 } }, required: ['orderIds'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_trade_cancel_execute', description: 'Cancel the exact prediction orders in a preview after a later user message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: executionProperties, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_prediction_trade_redeem_preview', description: 'Create a five-minute FnzSafe preview for redeeming up to 20 exact winning prediction tokens.', inputSchema: { type: 'object', properties: { tokenIds: { type: 'string', minLength: 1, maxLength: 2580 }, chainId: { type: 'string', enum: PREDICTION_CHAIN_IDS } }, required: ['tokenIds', 'chainId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_prediction_trade_redeem_execute', description: 'Redeem the exact winning prediction tokens in a preview after a later user message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: executionProperties, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_defi_protocols', description: 'List Binance Web3 DeFi protocols with TVL and APY.', inputSchema: { type: 'object', properties: { chainId: chainProperty, investType: { type: 'string', enum: ['Earn', 'Loan', 'LiquidityPool'] }, sortField: { type: 'string', enum: ['tvl', 'apy'], default: 'tvl' }, sortDirection: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' }, page: { type: 'integer', minimum: 1, maximum: 10_000 }, size: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_defi_protocol', description: 'Read details for one Binance Web3 DeFi protocol.', inputSchema: { type: 'object', properties: { defiProtocolId: identifierProperty }, required: ['defiProtocolId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_defi_investments', description: 'List Binance Web3 DeFi investments with optional protocol and token filters.', inputSchema: { type: 'object', properties: { investType: { type: 'string', enum: ['Earn', 'Loan', 'LiquidityPool'] }, defiProtocolId: identifierProperty, contractAddresses: { type: 'string', minLength: 32, maxLength: 89 }, chainId: chainProperty, sortField: { type: 'string', enum: ['apy', 'tvl'], default: 'apy' }, sortDirection: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' }, page: { type: 'integer', minimum: 1, maximum: 10_000 }, size: pageLimitProperty }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_defi_investment', description: 'Read details for one Binance Web3 DeFi investment product.', inputSchema: { type: 'object', properties: { investmentId: identifierProperty }, required: ['investmentId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_defi_positions', description: 'Read Binance Web3 DeFi positions for the connected wallet or one validated address.', inputSchema: { type: 'object', properties: { address: tokenProperty, chainId: chainProperty, defiProtocolId: identifierProperty, refresh: { type: 'boolean', default: false } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_defi_action_preview', description: 'Run the official Binance DeFi simulation and create a five-minute FnzSafe preview for deposit, redeem, LP add/remove, or claim. This does not broadcast.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['deposit', 'redeem', 'lp-add', 'lp-remove', 'claim'] }, investmentId: identifierProperty, tokenAddress: tokenProperty, amount: decimalProperty, ratio: decimalProperty, nftId: identifierProperty, tickLower: { type: 'string', pattern: '^-?[0-9]+$', maxLength: 16 }, tickUpper: { type: 'string', pattern: '^-?[0-9]+$', maxLength: 16 }, priceRange: decimalProperty, slippageBps: { oneOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer', minimum: 1, maximum: 4999 }] }, claimType: { type: 'string', enum: ['REWARD_PROTOCOL', 'REWARD_INVESTMENT', 'LP_FEE', 'REDEMPTION'] }, defiProtocolId: identifierProperty, redemptionId: identifierProperty, gasLevel: { type: 'string', enum: GAS_LEVELS, default: 'MEDIUM' }, chainId: { ...chainProperty, default: '56' } }, required: ['action'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_defi_action_execute', description: 'Execute one exact simulated Binance DeFi preview after a later user message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: executionProperties, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_contract_call_preview', description: 'Run Binance simulation and create a five-minute FnzSafe preview for an exact EVM or Solana contract call. This does not execute it.', inputSchema: { type: 'object', properties: { chainId: chainProperty, from: tokenProperty, to: evmAddressProperty, value: { type: 'string', pattern: '^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$', maxLength: 80 }, inputData: { type: 'string', pattern: '^0x(?:[0-9a-fA-F]{2})*$', maxLength: 524_290 }, unsignedTx: { type: 'string', minLength: 4, maxLength: 350_000 }, gasLimit: { type: 'integer', minimum: 21_000, maximum: 15_000_000 } }, required: ['chainId', 'from'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_contract_call_execute', description: 'Execute one exact simulated contract call after a later user message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: executionProperties, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_sign_message_preview', description: 'Run Binance validation and create a five-minute FnzSafe preview for an exact EIP-712 signature. This does not sign.', inputSchema: { type: 'object', properties: { chainId: evmChainProperty, message: { type: 'string', minLength: 2, maxLength: 65_536 }, signType: { type: 'string', enum: ['EIP712'], default: 'EIP712' } }, required: ['chainId', 'message'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_sign_message_execute', description: 'Sign one exact EIP-712 preview after a later user message exactly equal to CONFIRM.', inputSchema: { type: 'object', properties: executionProperties, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
  { name: 'binance_sign_message_result', description: 'Read the result of one Binance Agentic Wallet message-signature order.', inputSchema: { type: 'object', properties: { orderId: identifierProperty }, required: ['orderId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_sign_message_history', description: 'List Binance Agentic Wallet message-signature history.', inputSchema: { type: 'object', properties: { chainId: evmChainProperty, limit: pageLimitProperty, nextToken: { type: 'string', minLength: 1, maxLength: 512 }, startTime: { type: 'integer', minimum: 0 }, endTime: { type: 'integer', minimum: 0 }, sortType: { type: 'string', enum: ['ASC', 'DESC'] } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_x402_payment_options', description: 'Validate an x402 PaymentRequired JSON payload and list Binance payment options without signing.', inputSchema: { type: 'object', properties: { paymentRequirements: { type: 'string', minLength: 2, maxLength: 131_072 } }, required: ['paymentRequirements'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_x402_payment_sign_preview', description: 'Create a five-minute FnzSafe preview for signing one exact x402 payment option. This does not sign or pay.', inputSchema: { type: 'object', properties: { paymentId: identifierProperty, selectedIndex: { type: 'integer', minimum: 0, maximum: 1000 } }, required: ['paymentId', 'selectedIndex'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'binance_x402_payment_sign_execute', description: 'Sign one exact x402 payment option after a later user message exactly equal to CONFIRM. The result may include an approval transaction.', inputSchema: { type: 'object', properties: executionProperties, required: ['previewToken', 'confirmation'], additionalProperties: false }, annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false } },
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
    case 'binance_prediction_market_list': {
      const command = ['prediction', 'market', 'list'];
      appendOption(command, '--l1Category', optionalIdentifier(args, 'l1Category', 64));
      appendOption(command, '--l2Category', optionalIdentifier(args, 'l2Category', 64));
      const sortBy = optionalString(args, 'sortBy', 32);
      if (sortBy) appendOption(command, '--sortBy', choice(sortBy, 'sortBy', ['RECOMMENDED', 'VOLUME', 'PARTICIPANTS', 'CREATED_TIME', 'END_DATE']));
      appendOption(command, '--orderBy', choice(text(args?.orderBy || 'DESC'), 'orderBy', ['ASC', 'DESC']));
      appendOption(command, '--offset', boundedInteger(args, 'offset', { defaultValue: 0, max: 1_000_000 }));
      appendOption(command, '--limit', positiveInteger(args, 'limit', 20, 100));
      return runBaw(command);
    }
    case 'binance_prediction_market_detail': return runBaw(['prediction', 'market', 'detail', '--marketTopicId', identifier(args, 'marketTopicId')]);
    case 'binance_prediction_market_search': return runBaw(['prediction', 'market', 'search', '--query', requiredString(args, 'query', 200), '--limit', String(positiveInteger(args, 'limit', 10, 50))]);
    case 'binance_prediction_order_book': return runBaw(['prediction', 'market', 'order-book', '--marketId', identifier(args, 'marketId'), '--tokenId', identifier(args, 'tokenId')]);
    case 'binance_prediction_last_trade_price': return runBaw(['prediction', 'market', 'last-trade-price', '--marketId', identifier(args, 'marketId')]);
    case 'binance_prediction_categories': return runBaw(['prediction', 'category', 'list']);
    case 'binance_prediction_positions': return runBaw([
      'prediction', 'position', 'list',
      '--tab', choice(text(args?.tab || 'ONGOING'), 'tab', ['ONGOING', 'ENDED', 'PENDING_CLAIM']),
      '--offset', String(boundedInteger(args, 'offset', { defaultValue: 0, max: 1_000_000 })),
      '--limit', String(positiveInteger(args, 'limit', 20, 100)),
    ]);
    case 'binance_prediction_position': return runBaw(['prediction', 'position', 'token', '--tokenId', identifier(args, 'tokenId')]);
    case 'binance_prediction_settled_history': {
      const command = [
        'prediction', 'position', 'settled-history',
        '--filter', choice(text(args?.filter || 'all'), 'filter', ['all', 'win', 'lose']),
        '--offset', String(boundedInteger(args, 'offset', { defaultValue: 0, max: 1_000_000 })),
        '--limit', String(positiveInteger(args, 'limit', 20, 100)),
      ];
      appendOption(command, '--l1Category', optionalIdentifier(args, 'l1Category', 64));
      return runBaw(command);
    }
    case 'binance_prediction_pnl': {
      const command = [
        'prediction', 'position', 'pnl',
        '--offset', String(boundedInteger(args, 'offset', { defaultValue: 0, max: 1_000_000 })),
        '--limit', String(positiveInteger(args, 'limit', 20, 100)),
      ];
      appendOption(command, '--tokenId', optionalIdentifier(args, 'tokenId'));
      appendOption(command, '--l1Category', optionalIdentifier(args, 'l1Category', 64));
      return runBaw(command);
    }
    case 'binance_prediction_portfolio': return runBaw(['prediction', 'position', 'portfolio']);
    case 'binance_prediction_order_history': {
      const command = [
        'prediction', 'order', 'history',
        '--offset', String(boundedInteger(args, 'offset', { defaultValue: 0, max: 1_000_000 })),
        '--limit', String(positiveInteger(args, 'limit', 20, 100)),
      ];
      const status = optionalString(args, 'status', 32);
      if (status) appendOption(command, '--status', choice(status, 'status', ['PENDING', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'FAILED', 'EXPIRED']));
      appendOption(command, '--l1Category', optionalIdentifier(args, 'l1Category', 64));
      const orderType = optionalString(args, 'orderType', 16);
      if (orderType) appendOption(command, '--orderType', choice(orderType, 'orderType', ['MARKET', 'LIMIT']));
      return runBaw(command);
    }
    case 'binance_prediction_trade_quote': return runBaw(predictionQuoteArgs(predictionQuoteParameters(args)));
    case 'binance_prediction_trade_place_preview': {
      const parameters = predictionPlaceParameters(args);
      const quota = await runBaw(['wallet', 'left-quota']);
      if (quota?.success === false) return quota;
      return previewResult('prediction-place', parameters, { quota });
    }
    case 'binance_prediction_trade_cancel_preview': {
      const parameters = { orderIds: identifierList(args, 'orderIds') };
      return previewResult('prediction-cancel', parameters);
    }
    case 'binance_prediction_trade_redeem_preview': {
      const parameters = {
        tokenIds: identifierList(args, 'tokenIds'),
        chainId: choice(requiredString(args, 'chainId', 16), 'chainId', PREDICTION_CHAIN_IDS),
      };
      const positions = await runBaw(['prediction', 'position', 'list', '--tab', 'PENDING_CLAIM', '--offset', '0', '--limit', '100']);
      if (positions?.success === false) return positions;
      return previewResult('prediction-redeem', parameters, { positions });
    }
    case 'binance_defi_protocols': {
      const command = ['defi', 'protocol-list'];
      appendOption(command, '--binanceChainId', optionalChainId(args));
      const investType = optionalString(args, 'investType', 32);
      if (investType) appendOption(command, '--investType', choice(investType, 'investType', ['Earn', 'Loan', 'LiquidityPool']));
      appendOption(command, '--sortField', choice(text(args?.sortField || 'tvl'), 'sortField', ['tvl', 'apy']));
      appendOption(command, '--sortDirection', choice(text(args?.sortDirection || 'DESC'), 'sortDirection', ['ASC', 'DESC']));
      appendOption(command, '--page', positiveInteger(args, 'page', 1, 10_000));
      appendOption(command, '--size', positiveInteger(args, 'size', 200, 200));
      return runBaw(command);
    }
    case 'binance_defi_protocol': return runBaw(['defi', 'protocol-info', '--defiProtocolId', identifier(args, 'defiProtocolId')]);
    case 'binance_defi_investments': {
      const command = ['defi', 'investment-list'];
      const chain = optionalChainId(args);
      const investType = optionalString(args, 'investType', 32);
      if (investType) appendOption(command, '--investType', choice(investType, 'investType', ['Earn', 'Loan', 'LiquidityPool']));
      appendOption(command, '--defiProtocolId', optionalIdentifier(args, 'defiProtocolId'));
      const contractAddresses = optionalString(args, 'contractAddresses', 89);
      if (contractAddresses) {
        const values = contractAddresses.split(',').map((value) => value.trim()).filter(Boolean);
        if (values.length === 0 || values.length > 2) throw new Error('contractAddresses must contain one or two addresses');
        appendOption(command, '--contractAddresses', values.map((value) => addressForKnownChain(value, chain, 'contractAddresses')).join(','));
      }
      appendOption(command, '--binanceChainId', chain);
      appendOption(command, '--sortField', choice(text(args?.sortField || 'apy'), 'sortField', ['apy', 'tvl']));
      appendOption(command, '--sortDirection', choice(text(args?.sortDirection || 'DESC'), 'sortDirection', ['ASC', 'DESC']));
      appendOption(command, '--page', positiveInteger(args, 'page', 1, 10_000));
      appendOption(command, '--size', positiveInteger(args, 'size', 20, 100));
      return runBaw(command);
    }
    case 'binance_defi_investment': return runBaw(['defi', 'investment-info', '--investmentId', identifier(args, 'investmentId')]);
    case 'binance_defi_positions': {
      const command = ['defi', 'position'];
      const chain = optionalChainId(args);
      const address = optionalString(args, 'address', 44);
      if (address) appendOption(command, '--address', addressForKnownChain(address, chain, 'address'));
      appendOption(command, '--binanceChainId', chain);
      appendOption(command, '--defiProtocolId', optionalIdentifier(args, 'defiProtocolId'));
      if (args?.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh must be a boolean');
      if (args?.refresh === true) command.push('--refresh');
      return runBaw(command);
    }
    case 'binance_defi_action_preview': {
      const parameters = defiActionParameters(args);
      const simulation = await runBaw(defiArgs(parameters, true));
      if (simulation?.success === false) return simulation;
      return previewResult(`defi-${parameters.action}`, parameters, { simulation });
    }
    case 'binance_contract_call_preview': {
      const parameters = contractCallParameters(args);
      const simulation = await runBaw(contractCallArgs(parameters));
      if (simulation?.success === false) return simulation;
      const requestId = identifier(simulation, 'requestId', 256);
      return previewResult('contract-call', { ...parameters, requestId }, { simulation });
    }
    case 'binance_sign_message_preview': {
      if (args?.signType !== undefined) choice(requiredString(args, 'signType', 16), 'signType', ['EIP712']);
      const parameters = signMessageParameters(args);
      const simulation = await runBaw(['sign-message', 'preview', '--binanceChainId', parameters.chainId, '--message', parameters.message, '--signType', parameters.signType]);
      if (simulation?.success === false) return simulation;
      const requestId = identifier(simulation, 'requestId', 256);
      return previewResult('sign-message', { ...parameters, requestId }, { simulation });
    }
    case 'binance_sign_message_result': return runBaw(['sign-message', 'result', '--order-id', identifier(args, 'orderId', 256)]);
    case 'binance_sign_message_history': {
      const command = ['sign-message', 'history'];
      appendOption(command, '--binanceChainId', optionalChainId(args, EVM_CHAIN_IDS));
      appendOption(command, '--limit', positiveInteger(args, 'limit', 20, 100));
      appendOption(command, '--nextToken', optionalString(args, 'nextToken', 512));
      if (args?.startTime !== undefined) appendOption(command, '--startTime', boundedInteger(args, 'startTime', { max: Number.MAX_SAFE_INTEGER }));
      if (args?.endTime !== undefined) appendOption(command, '--endTime', boundedInteger(args, 'endTime', { max: Number.MAX_SAFE_INTEGER }));
      if (args?.startTime !== undefined && args?.endTime !== undefined && args.startTime > args.endTime) throw new Error('startTime must not be after endTime');
      const sortType = optionalString(args, 'sortType', 8);
      if (sortType) appendOption(command, '--sortType', choice(sortType, 'sortType', ['ASC', 'DESC']));
      return runBaw(command);
    }
    case 'binance_x402_payment_options': return runBaw(['x402-payment', 'preview', '--paymentRequirements', paymentRequirements(args)]);
    case 'binance_x402_payment_sign_preview': {
      const parameters = {
        paymentId: identifier(args, 'paymentId', 256),
        selectedIndex: boundedInteger(args, 'selectedIndex', { min: 0, max: 1000 }),
      };
      return previewResult('x402-sign', parameters);
    }
    case 'binance_web3_swap_execute':
    case 'binance_web3_limit_order_execute':
    case 'binance_web3_limit_cancel_execute':
    case 'binance_web3_transfer_execute':
    case 'binance_web3_transaction_cancel_execute':
    case 'binance_web3_transaction_speedup_execute':
    case 'binance_web3_approval_revoke_execute':
    case 'binance_web3_wallet_signout_execute':
    case 'binance_prediction_trade_place_execute':
    case 'binance_prediction_trade_cancel_execute':
    case 'binance_prediction_trade_redeem_execute':
    case 'binance_defi_action_execute':
    case 'binance_contract_call_execute':
    case 'binance_sign_message_execute':
    case 'binance_x402_payment_sign_execute': {
      confirmation(args);
      const preview = decodePreview(requiredString(args, 'previewToken', MAX_PREVIEW_TOKEN_LENGTH));
      let expected = 'limit-cancel';
      if (name === 'binance_web3_swap_execute') expected = 'swap';
      else if (name === 'binance_web3_limit_order_execute') expected = 'limit-order';
      else if (name === 'binance_web3_transfer_execute') expected = 'transfer';
      else if (name === 'binance_web3_transaction_cancel_execute') expected = 'transaction-cancel';
      else if (name === 'binance_web3_transaction_speedup_execute') expected = 'transaction-speedup';
      else if (name === 'binance_web3_approval_revoke_execute') expected = 'approval-revoke';
      else if (name === 'binance_web3_wallet_signout_execute') expected = 'signout';
      else if (name === 'binance_prediction_trade_place_execute') expected = 'prediction-place';
      else if (name === 'binance_prediction_trade_cancel_execute') expected = 'prediction-cancel';
      else if (name === 'binance_prediction_trade_redeem_execute') expected = 'prediction-redeem';
      else if (name === 'binance_defi_action_execute') expected = preview.operation.startsWith('defi-') ? preview.operation : '';
      else if (name === 'binance_contract_call_execute') expected = 'contract-call';
      else if (name === 'binance_sign_message_execute') expected = 'sign-message';
      else if (name === 'binance_x402_payment_sign_execute') expected = 'x402-sign';
      if (preview.operation !== expected) throw new Error(`preview operation must be ${expected}`);
      await consumePreview(preview);
      if (expected === 'swap') return runBaw(swapArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'limit-order') return runBaw(limitArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'transfer') return runBaw(sendArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'transaction-cancel') return runBaw(pendingTransactionArgs('cancel', preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'transaction-speedup') return runBaw(pendingTransactionArgs('speed-up', preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'approval-revoke') return runBaw(approvalArgs('revoke', preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'signout') return runBaw(['auth', 'signout'], WRITE_TIMEOUT_MS);
      if (expected === 'prediction-place') return runBaw(predictionPlaceArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'prediction-cancel') return runBaw(['prediction', 'trade', 'cancel', '--orderIds', preview.parameters.orderIds], WRITE_TIMEOUT_MS);
      if (expected === 'prediction-redeem') return runBaw(['prediction', 'trade', 'redeem', '--tokenIds', preview.parameters.tokenIds, '--binanceChainId', preview.parameters.chainId], WRITE_TIMEOUT_MS);
      if (expected.startsWith('defi-')) return runBaw(defiArgs(preview.parameters), WRITE_TIMEOUT_MS);
      if (expected === 'contract-call') return runBaw(['contract-call', 'execute', '--requestId', preview.parameters.requestId], WRITE_TIMEOUT_MS);
      if (expected === 'sign-message') return runBaw(['sign-message', 'execute', '--requestId', preview.parameters.requestId], WRITE_TIMEOUT_MS);
      if (expected === 'x402-sign') return runBaw(['x402-payment', 'sign', '--paymentId', preview.parameters.paymentId, '--selectedIndex', String(preview.parameters.selectedIndex)], WRITE_TIMEOUT_MS);
      return runBaw(['limit-order', 'cancel', '--strategyId', requiredString(preview.parameters, 'strategyId', 64)], WRITE_TIMEOUT_MS);
    }
    default: throw new Error(`Unknown Binance Web3 tool: ${name}`);
  }
}

async function runServer() {
  const server = new Server(
    { name: 'fnzsafe-binance-web3-wallet', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'Binance Agentic Wallet, Prediction, DeFi, contract calls, EIP-712, and x402 through FnzSafe. Every write or signature requires a signed preview and a later user message exactly equal to CONFIRM. Never retry a write automatically.' },
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
  const rejects = (callback, label) => {
    try {
      callback();
    } catch {
      return;
    }
    throw new Error(`${label} was accepted`);
  };
  await fs.access(bawEntryPath());
  const { stdout } = await execFileAsync(process.execPath, ['--no-addons', bawEntryPath(), '--version'], { timeout: 10_000 });
  if (!/^1\.10\./u.test(text(stdout))) throw new Error(`unexpected Binance Agentic Wallet CLI version: ${text(stdout)}`);
  const secret = 'a'.repeat(32);
  const now = 1_000_000;
  const token = createPreview('swap', { chainId: '56' }, secret, now);
  const preview = decodePreview(token, secret, now + 1);
  if (preview.operation !== 'swap' || preview.parameters.chainId !== '56') throw new Error('Binance Web3 preview round-trip failed');
  const largeToken = createPreview('sign-message', { message: 'x'.repeat(65_536) }, secret, now);
  if (largeToken.length > MAX_PREVIEW_TOKEN_LENGTH || decodePreview(largeToken, secret, now + 1).parameters.message.length !== 65_536) {
    throw new Error('large Binance Web3 preview round-trip failed');
  }
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
  const requiredTools = [
    'binance_web3_approval_revoke_execute',
    'binance_prediction_trade_place_execute',
    'binance_defi_action_execute',
    'binance_contract_call_execute',
    'binance_sign_message_execute',
    'binance_x402_payment_sign_execute',
  ];
  if (requiredTools.some((name) => !tools.some((tool) => tool.name === name))) throw new Error('Binance Web3 extended tools are missing');
  const prediction = predictionQuoteParameters({ chainId: '137', tokenId: 'outcome_1', marketTopicId: 'topic_1', side: 'buy', amount: '10', orderType: 'MARKET' });
  if (!predictionQuoteArgs(prediction).includes('137')) throw new Error('Prediction quote command construction failed');
  const defi = defiActionParameters({
    action: 'lp-add', chainId: '56', investmentId: 'pancake_v3', tokenAddress: `0x${'4'.repeat(40)}`,
    amount: '1', priceRange: '5', slippageBps: 100,
  });
  if (!defiArgs(defi, true).includes('--action')) throw new Error('DeFi preview command construction failed');
  const contract = contractCallParameters({
    chainId: '56', from: `0x${'5'.repeat(40)}`, to: `0x${'6'.repeat(40)}`, value: '0', inputData: '0x', gasLimit: 100_000,
  });
  if (!contractCallArgs(contract).includes('100000')) throw new Error('contract-call command construction failed');
  const typedMessage = JSON.stringify({
    method: 'eth_signTypedData_v4',
    params: [`0x${'7'.repeat(40)}`, { types: { EIP712Domain: [], Permit: [] }, domain: { chainId: 56 }, primaryType: 'Permit', message: {} }],
  });
  if (signMessageParameters({ chainId: '56', message: typedMessage }).signType !== 'EIP712') throw new Error('EIP-712 validation failed');
  const x402 = paymentRequirements({ paymentRequirements: Buffer.from('{"x402Version":2,"accepts":[]}').toString('base64') });
  if (JSON.parse(x402).x402Version !== 2) throw new Error('x402 payload validation failed');
  rejects(() => pendingTransactionParameters({ txHash: `0x${'1'.repeat(64)}`, chainId: 'CT_501' }), 'Solana replacement transaction');
  rejects(() => swapParameters({ ...parameters, slippage: 6 }), 'unsafe Binance Web3 slippage');
  rejects(() => predictionQuoteParameters({ ...prediction, chainId: '1' }), 'unsupported prediction chain');
  rejects(() => identifierList({ orderIds: 'same,same' }, 'orderIds'), 'duplicate prediction IDs');
  rejects(() => defiActionParameters({
    action: 'lp-add', chainId: '56', investmentId: 'pool', tokenAddress: `0x${'8'.repeat(40)}`,
    amount: '1', nftId: '1', priceRange: '5',
  }), 'ambiguous LP source');
  rejects(() => contractCallParameters({
    chainId: 'CT_501', from: '11111111111111111111111111111111', unsignedTx: 'AQ==', to: `0x${'9'.repeat(40)}`,
  }), 'mixed Solana contract-call fields');
  rejects(() => signMessageParameters({ chainId: '1', message: typedMessage }), 'mismatched EIP-712 chain');
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
