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

const registry = validateWeb3MarketRegistry();
assert.deepEqual(registry, { ok: true, duplicates: [], missingHandlers: [], orphanHandlers: [] });
assert.equal(web3MarketTools.length, 19);

const byName = new Map(web3MarketTools.map((tool) => [tool.name, tool]));
const validate = (name, args) => validateToolArguments(byName.get(name).inputSchema, args);

assert.deepEqual(validate('market_search', { query: 'solana' }), { query: 'solana' });
assert.throws(() => validate('market_search', {}), /query is required/u);
assert.throws(() => validate('market_search', { query: 42 }), /query must be a string/u);
assert.throws(() => validate('market_search', { query: 'x', extra: true }), /unknown argument: extra/u);
assert.throws(() => validate('market_search', { query: 'x'.repeat(121) }), /query is too long/u);
assert.throws(() => validate('market_leaders', { order: 'invalid' }), /order must be one of/u);
assert.throws(() => validate('market_leaders', { limit: 1.5 }), /limit must be an integer/u);
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

process.stdout.write(`${JSON.stringify({ ok: true, tools: web3MarketTools.length, checks: 25 })}\n`);
