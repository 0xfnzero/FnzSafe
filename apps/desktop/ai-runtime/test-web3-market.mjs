#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import {
  boundedInteger,
  boundedNumber,
  fetchText,
  jsonContent,
  requiredText,
  upstreamRequestError,
  validateToolArguments,
} from './plugins/lib/web3-utils.mjs';
import {
  validateWeb3MarketRegistry,
  web3MarketHandlers,
  web3MarketTools,
} from './plugins/web3-market-tools.mjs';
import { binanceAgentInternals } from './plugins/providers/binance-agent.mjs';

const registry = validateWeb3MarketRegistry();
assert.deepEqual(registry, { ok: true, duplicates: [], missingHandlers: [], orphanHandlers: [] });
assert.equal(web3MarketTools.length, 28);

const byName = new Map(web3MarketTools.map((tool) => [tool.name, tool]));
const validate = (name, args) => validateToolArguments(byName.get(name).inputSchema, args);

assert.deepEqual(validate('market_search', { query: 'solana' }), { query: 'solana' });
assert.throws(() => validate('market_search', {}), /query is required/u);
assert.throws(() => validate('market_search', { query: 42 }), /query must be a string/u);
assert.throws(() => validate('market_search', { query: 'x', extra: true }), /unknown argument: extra/u);
assert.throws(() => validate('market_search', { query: 'x'.repeat(121) }), /query is too long/u);
assert.throws(() => validate('market_leaders', { order: 'invalid' }), /order must be one of/u);
assert.throws(() => validate('market_leaders', { limit: 1.5 }), /limit must be an integer/u);
assert.deepEqual(validate('binance_spot_order_execute', {
  previewToken: 'x'.repeat(40),
  confirmation: 'CONFIRM',
}), { previewToken: 'x'.repeat(40), confirmation: 'CONFIRM' });
assert.throws(
  () => validate('binance_spot_order_execute', { previewToken: 'x'.repeat(40), confirmation: 'yes' }),
  /confirmation must be one of/u,
);
assert.throws(
  () => validate('binance_spot_order_preview', { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '1'.repeat(41) }),
  /quoteOrderQty is too long/u,
);
assert.throws(
  () => validate('automated_token_sell', {
    walletId: 'a'.repeat(32),
    mint: '1'.repeat(32),
    venue: 'pumpfun',
    sellPercentBps: 2501,
    slippageBps: 100,
  }),
  /sellPercentBps exceeds the maximum/u,
);
assert.throws(
  () => validate('wallet_session_status', { walletId: '../wallet' }),
  /walletId has an invalid format/u,
);
assert.throws(() => validate('token_security_scan', { address: 'x'.repeat(20), network: 'ethereum' }), /network has an invalid format/u);
assert.throws(() => validate('token_security_scan', { address: 'x'.repeat(32), network: '0' }), /network has an invalid format/u);
assert.throws(() => requiredText({}, 'query'), /query is required/u);
assert.throws(() => requiredText({ query: 42 }, 'query'), /query is required/u);
assert.throws(() => boundedInteger({ limit: 1.5 }, 'limit', 10, 1, 30), /limit must be an integer/u);
assert.throws(() => boundedNumber({ minApy: Number.NaN }, 'minApy', 0, 0, 100), /minApy must be a finite number/u);
await assert.rejects(
  () => web3MarketHandlers.token_security_scan({ address: 'x'.repeat(40), network: '1' }),
  /address is not valid for 1/u,
);
await assert.rejects(
  () => web3MarketHandlers.token_security_scan({ address: '0x0000000000000000000000000000000000000000', network: 'solana' }),
  /address is not valid for solana/u,
);
await assert.rejects(
  () => web3MarketHandlers.defi_yield_search({ minApy: 10, maxApy: 5 }),
  /minApy cannot exceed maxApy/u,
);
await assert.rejects(
  () => web3MarketHandlers.wallet_session_status({ walletId: 'a'.repeat(32) }),
  /wallet automation is unavailable/u,
);
const initiallyConfiguredBinanceApiKey = process.env.FNZSAFE_BINANCE_API_KEY;
const initiallyConfiguredBinanceSecretKey = process.env.FNZSAFE_BINANCE_SECRET_KEY;
const initiallyConfiguredBinanceEnvironment = process.env.FNZSAFE_BINANCE_ENVIRONMENT;
try {
  process.env.FNZSAFE_BINANCE_ENVIRONMENT = 'testnet';
  delete process.env.FNZSAFE_BINANCE_API_KEY;
  delete process.env.FNZSAFE_BINANCE_SECRET_KEY;
  await assert.rejects(
    () => web3MarketHandlers.binance_spot_account({}),
    /Binance testnet API credentials are not configured/u,
  );
} finally {
  if (initiallyConfiguredBinanceEnvironment === undefined) delete process.env.FNZSAFE_BINANCE_ENVIRONMENT;
  else process.env.FNZSAFE_BINANCE_ENVIRONMENT = initiallyConfiguredBinanceEnvironment;
  if (initiallyConfiguredBinanceApiKey !== undefined) process.env.FNZSAFE_BINANCE_API_KEY = initiallyConfiguredBinanceApiKey;
  if (initiallyConfiguredBinanceSecretKey !== undefined) process.env.FNZSAFE_BINANCE_SECRET_KEY = initiallyConfiguredBinanceSecretKey;
}

const binanceSnapshot = {
  symbol: 'BTCUSDT',
  status: 'TRADING',
  isSpotTradingAllowed: true,
  quoteOrderQtyMarketAllowed: true,
  orderTypes: ['MARKET', 'LIMIT'],
  price: '100.00',
  filters: [
    { filterType: 'PRICE_FILTER', minPrice: '0.10', maxPrice: '1000000.00', tickSize: '0.10' },
    { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000.000', stepSize: '0.001' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '1000.000', stepSize: '0.001' },
    { filterType: 'MIN_NOTIONAL', minNotional: '10.00', applyToMarket: true },
  ],
};
assert.deepEqual(
  binanceAgentInternals.orderParameters({ side: 'BUY', type: 'LIMIT', quantity: '0.2', price: '100.10' }, binanceSnapshot),
  {
    side: 'BUY', type: 'LIMIT', quantity: '0.2', quoteOrderQty: '', price: '100.10',
    referencePrice: '100.10', estimatedQuote: '20.02',
  },
);
assert.throws(
  () => binanceAgentInternals.orderParameters({ side: 'BUY', type: 'LIMIT', quantity: '0.2', price: '100.11' }, binanceSnapshot),
  /price must align/u,
);
assert.throws(
  () => binanceAgentInternals.orderParameters({ side: 'SELL', type: 'MARKET', quantity: '0.2005' }, binanceSnapshot),
  /quantity must align/u,
);
assert.throws(
  () => binanceAgentInternals.orderParameters({ side: 'BUY', type: 'MARKET', quoteOrderQty: '5' }, binanceSnapshot),
  /minimum notional/u,
);

const previousBinanceEnvironment = process.env.FNZSAFE_BINANCE_ENVIRONMENT;
const previousBinanceApiKey = process.env.FNZSAFE_BINANCE_API_KEY;
const previousBinanceSecretKey = process.env.FNZSAFE_BINANCE_SECRET_KEY;
const previousBinanceTradingEnabled = process.env.FNZSAFE_BINANCE_TRADING_ENABLED;
const previousBinanceOrderLimit = process.env.FNZSAFE_BINANCE_MAX_ORDER_QUOTE;
const previousBinanceUserConfirmed = process.env.FNZSAFE_BINANCE_USER_CONFIRMED;
const originalFetch = globalThis.fetch;
try {
  process.env.FNZSAFE_BINANCE_ENVIRONMENT = 'testnet';
  process.env.FNZSAFE_BINANCE_API_KEY = 'test-api-key-value';
  process.env.FNZSAFE_BINANCE_SECRET_KEY = 'test-secret-key-value';
  process.env.FNZSAFE_BINANCE_TRADING_ENABLED = '1';
  process.env.FNZSAFE_BINANCE_MAX_ORDER_QUOTE = '1000';
  process.env.FNZSAFE_BINANCE_USER_CONFIRMED = '0';
  const previewPayload = {
    v: 1,
    kind: 'spot-order',
    environment: 'testnet',
    estimatedQuote: '20.02',
    expiresAt: Date.now() + 60_000,
  };
  const previewToken = binanceAgentInternals.encodePreview(previewPayload, process.env.FNZSAFE_BINANCE_SECRET_KEY);
  assert.deepEqual(binanceAgentInternals.decodePreview(previewToken, 'spot-order').payload, previewPayload);
  const replacement = previewToken.endsWith('a') ? 'b' : 'a';
  assert.throws(
    () => binanceAgentInternals.decodePreview(`${previewToken.slice(0, -1)}${replacement}`, 'spot-order'),
    /integrity check failed/u,
  );
  const expiredToken = binanceAgentInternals.encodePreview(
    { ...previewPayload, expiresAt: Date.now() - 1 },
    process.env.FNZSAFE_BINANCE_SECRET_KEY,
  );
  assert.throws(() => binanceAgentInternals.decodePreview(expiredToken, 'spot-order'), /expired/u);

  const binanceRequests = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    binanceRequests.push({ parsed, init });
    if (parsed.pathname === '/api/v3/exchangeInfo') {
      return new Response(JSON.stringify({ symbols: [{ ...binanceSnapshot, filters: binanceSnapshot.filters }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (parsed.pathname === '/api/v3/ticker/price') {
      return new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '100.00' }), { status: 200 });
    }
    assert.equal(init.headers['X-MBX-APIKEY'], 'test-api-key-value');
    assert.doesNotMatch(String(init.body), /test-secret-key-value/u);
    if (parsed.pathname === '/api/v3/order/test') return new Response('{}', { status: 200 });
    if (parsed.pathname === '/api/v3/order') {
      const params = new URLSearchParams(init.body);
      return new Response(JSON.stringify({
        symbol: params.get('symbol'),
        orderId: 42,
        clientOrderId: params.get('newClientOrderId'),
        price: params.get('price'),
        origQty: params.get('quantity'),
        executedQty: '0',
        cummulativeQuoteQty: '0',
        status: 'NEW',
        timeInForce: params.get('timeInForce'),
        type: params.get('type'),
        side: params.get('side'),
        transactTime: Date.now(),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ msg: 'unexpected test request' }), { status: 404 });
  };
  const previewResult = JSON.parse((await web3MarketHandlers.binance_spot_order_preview({
    symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.2', price: '100.10',
  })).content[0].text);
  assert.equal(previewResult.preview.estimatedQuote, '20.02');
  assert.equal(binanceRequests.filter(({ parsed }) => parsed.pathname === '/api/v3/order/test').length, 1);
  await assert.rejects(
    () => web3MarketHandlers.binance_spot_order_execute({ previewToken: previewResult.previewToken, confirmation: 'NO' }),
    /exactly CONFIRM/u,
  );
  await assert.rejects(
    () => web3MarketHandlers.binance_spot_order_execute({ previewToken: previewResult.previewToken, confirmation: 'CONFIRM' }),
    /new user message/u,
  );
  process.env.FNZSAFE_BINANCE_USER_CONFIRMED = '1';
  const executionResult = JSON.parse((await web3MarketHandlers.binance_spot_order_execute({
    previewToken: previewResult.previewToken,
    confirmation: 'CONFIRM',
  })).content[0].text);
  assert.equal(executionResult.status, 'submitted');
  assert.equal(executionResult.order.clientOrderId, previewResult.preview.clientOrderId);
  assert.equal(binanceRequests.filter(({ parsed }) => parsed.pathname === '/api/v3/order').length, 1);
} finally {
  globalThis.fetch = originalFetch;
  if (previousBinanceEnvironment === undefined) delete process.env.FNZSAFE_BINANCE_ENVIRONMENT;
  else process.env.FNZSAFE_BINANCE_ENVIRONMENT = previousBinanceEnvironment;
  if (previousBinanceApiKey === undefined) delete process.env.FNZSAFE_BINANCE_API_KEY;
  else process.env.FNZSAFE_BINANCE_API_KEY = previousBinanceApiKey;
  if (previousBinanceSecretKey === undefined) delete process.env.FNZSAFE_BINANCE_SECRET_KEY;
  else process.env.FNZSAFE_BINANCE_SECRET_KEY = previousBinanceSecretKey;
  if (previousBinanceTradingEnabled === undefined) delete process.env.FNZSAFE_BINANCE_TRADING_ENABLED;
  else process.env.FNZSAFE_BINANCE_TRADING_ENABLED = previousBinanceTradingEnabled;
  if (previousBinanceOrderLimit === undefined) delete process.env.FNZSAFE_BINANCE_MAX_ORDER_QUOTE;
  else process.env.FNZSAFE_BINANCE_MAX_ORDER_QUOTE = previousBinanceOrderLimit;
  if (previousBinanceUserConfirmed === undefined) delete process.env.FNZSAFE_BINANCE_USER_CONFIRMED;
  else process.env.FNZSAFE_BINANCE_USER_CONFIRMED = previousBinanceUserConfirmed;
}

const oversized = jsonContent({ source: 'test', payload: 'x'.repeat(50_000) });
const oversizedPayload = JSON.parse(oversized.content[0].text);
assert.equal(oversizedPayload.source, 'test');
assert.match(oversizedPayload.error, /exceeded/u);
assert.equal(
  upstreamRequestError('api.example.com', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }).message,
  'api.example.com request failed: UND_ERR_CONNECT_TIMEOUT',
);

let cacheRequestCount = 0;
const cacheServer = http.createServer((_request, response) => {
  cacheRequestCount += 1;
  setTimeout(() => response.end(`response-${cacheRequestCount}`), 20);
});
await new Promise((resolve) => cacheServer.listen(0, '127.0.0.1', resolve));
try {
  const address = cacheServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/cache`;
  const [uncachedCaller, cachedCaller] = await Promise.all([
    fetchText(url),
    fetchText(url, 30_000),
  ]);
  assert.equal(uncachedCaller, cachedCaller);
  assert.equal(await fetchText(url, 30_000), cachedCaller);
  assert.equal(cacheRequestCount, 1);
} finally {
  cacheServer.closeAllConnections();
  await new Promise((resolve) => cacheServer.close(resolve));
}

const oversizedServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  const chunk = Buffer.alloc(1_000_000, 0x61);
  let sent = 0;
  const write = () => {
    while (sent < 21 && !response.destroyed) {
      sent += 1;
      if (!response.write(chunk)) {
        response.once('drain', write);
        return;
      }
    }
    if (!response.destroyed) response.end();
  };
  write();
});
await new Promise((resolve) => oversizedServer.listen(0, '127.0.0.1', resolve));
try {
  const address = oversizedServer.address();
  assert.ok(address && typeof address === 'object');
  await assert.rejects(
    () => fetchText(`http://127.0.0.1:${address.port}/oversized`),
    /response exceeded the safety limit/u,
  );
} finally {
  oversizedServer.closeAllConnections();
  await new Promise((resolve) => oversizedServer.close(resolve));
}

const rsaKeyPair = await crypto.subtle.generateKey(
  { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['encrypt', 'decrypt'],
);
const publicKeyDer = Buffer.from(await crypto.subtle.exportKey('spki', rsaKeyPair.publicKey));
const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyDer.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END PUBLIC KEY-----\n`;
let encryptedTradeBody = '';
const walletApiServer = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/secure/session') {
    response.end(JSON.stringify({ version: '1', algorithm: 'RSA-OAEP-256+A256GCM', public_key_pem: publicKeyPem }));
    return;
  }
  assert.equal(request.headers['x-fnzero-safe-token'], 'test-wallet-api-token');
  assert.equal(request.headers.origin, 'tauri://localhost');
  if (request.method === 'GET') {
    response.end(JSON.stringify({ wallet_id: 'a'.repeat(32), public_key: 'public-key', unlocked: true, expires_in_seconds: 60 }));
    return;
  }
  request.setEncoding('utf8');
  request.on('data', (chunk) => { encryptedTradeBody += chunk; });
  request.on('end', () => {
    assert.equal(request.headers['x-fnzero-safe-secure-body'], '1');
    response.end(JSON.stringify({
      status: 'success', signature: 'signature', dex: 'pumpfun', market: 'inner',
      sold_raw_amount: '42', decimals: 6, source_account: 'source',
    }));
  });
});
await new Promise((resolve) => walletApiServer.listen(0, '127.0.0.1', resolve));
const previousWalletApiUrl = process.env.FNZSAFE_WALLET_API_URL;
const previousWalletApiToken = process.env.FNZSAFE_WALLET_API_TOKEN;
try {
  const address = walletApiServer.address();
  assert.ok(address && typeof address === 'object');
  process.env.FNZSAFE_WALLET_API_URL = `http://127.0.0.1:${address.port}/api`;
  process.env.FNZSAFE_WALLET_API_TOKEN = 'test-wallet-api-token';
  const status = await web3MarketHandlers.wallet_session_status({ walletId: 'a'.repeat(32) });
  assert.equal(JSON.parse(status.content[0].text).unlocked, true);
  const trade = await web3MarketHandlers.automated_token_sell({
    walletId: 'a'.repeat(32),
    mint: '1'.repeat(32),
    venue: 'pumpfun',
    sellPercentBps: 1_000,
    slippageBps: 100,
  });
  assert.equal(JSON.parse(trade.content[0].text).signature, 'signature');
  assert.doesNotMatch(encryptedTradeBody, /sell_percent_bps|11111111111111111111111111111111/u);
  const envelope = JSON.parse(encryptedTradeBody);
  assert.equal(envelope.version, 1);
  assert.ok(envelope.encrypted_key && envelope.iv && envelope.ciphertext);
} finally {
  if (previousWalletApiUrl === undefined) delete process.env.FNZSAFE_WALLET_API_URL;
  else process.env.FNZSAFE_WALLET_API_URL = previousWalletApiUrl;
  if (previousWalletApiToken === undefined) delete process.env.FNZSAFE_WALLET_API_TOKEN;
  else process.env.FNZSAFE_WALLET_API_TOKEN = previousWalletApiToken;
  walletApiServer.closeAllConnections();
  await new Promise((resolve) => walletApiServer.close(resolve));
}

process.stdout.write(`${JSON.stringify({ ok: true, tools: web3MarketTools.length, checks: 44 })}\n`);
