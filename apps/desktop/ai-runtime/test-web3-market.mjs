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
assert.equal(web3MarketTools.length, 17);

const byName = new Map(web3MarketTools.map((tool) => [tool.name, tool]));
const validate = (name, args) => validateToolArguments(byName.get(name).inputSchema, args);

assert.deepEqual(validate('market_search', { query: 'solana' }), { query: 'solana' });
assert.throws(() => validate('market_search', {}), /query is required/u);
assert.throws(() => validate('market_search', { query: 42 }), /query must be a string/u);
assert.throws(() => validate('market_search', { query: 'x', extra: true }), /unknown argument: extra/u);
assert.throws(() => validate('market_search', { query: 'x'.repeat(121) }), /query is too long/u);
assert.throws(() => validate('market_leaders', { order: 'invalid' }), /order must be one of/u);
assert.throws(() => validate('market_leaders', { limit: 1.5 }), /limit must be an integer/u);
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

process.stdout.write(`${JSON.stringify({ ok: true, tools: web3MarketTools.length, checks: 17 })}\n`);
