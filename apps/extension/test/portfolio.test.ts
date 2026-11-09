import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChainInfo, PortfolioAsset } from '../src/types';
import { evmChain } from '../src/chains';
import {
  attachUsdPrices,
  discoverEvmTokens,
  nativeAsset,
  parseBlockscoutTokenBalances,
  retainUnrefreshedTokens,
  visiblePortfolioAssets,
} from '../src/portfolio';

const ethereum: ChainInfo = {
  key: 'evm:1',
  family: 'evm',
  name: 'Ethereum',
  symbol: 'ETH',
  icon: 'ethereum.svg',
  rpcUrl: 'https://example.invalid',
  chainId: 1,
  transactionSupport: true,
};

test('Blockscout discovery normalizes, deduplicates and filters zero balances', () => {
  const tokens = parseBlockscoutTokenBalances([
    { value: '1230000', token: { address_hash: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: '6', symbol: 'USDC', name: 'USD Coin', type: 'ERC-20' } },
    { value: '4560000', token: { address_hash: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: '6', symbol: 'DUP', name: 'Duplicate', type: 'ERC-20' } },
    { value: '0', token: { address_hash: '0x1111111111111111111111111111111111111111', decimals: '18', symbol: 'ZERO', name: 'Zero', type: 'ERC-20' } },
    { value: '1', token: { address_hash: '0x2222222222222222222222222222222222222222', decimals: '0', symbol: 'NFT', name: 'NFT', type: 'ERC-721' } },
  ], ethereum);

  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].address, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(tokens[0].balance, '1.23');
});

test('Blockscout tokens with unknown decimals are skipped instead of read as 0 decimals', () => {
  const tokens = parseBlockscoutTokenBalances([
    { value: '1000000', token: { address_hash: '0x1111111111111111111111111111111111111111', decimals: null, symbol: 'NULL', name: 'Null decimals', type: 'ERC-20' } },
    { value: '1000000', token: { address_hash: '0x2222222222222222222222222222222222222222', decimals: '', symbol: 'EMPTY', name: 'Empty decimals', type: 'ERC-20' } },
    { value: '1000000', token: { address_hash: '0x3333333333333333333333333333333333333333', symbol: 'MISSING', name: 'Missing decimals', type: 'ERC-20' } },
    { value: '1000000', token: { address_hash: '0x4444444444444444444444444444444444444444', decimals: '0', symbol: 'ZERO', name: 'Zero decimals', type: 'ERC-20' } },
    { value: '1000000', token: { address_hash: '0x5555555555555555555555555555555555555555', decimals: 6, symbol: 'NUM', name: 'Numeric decimals', type: 'ERC-20' } },
  ], ethereum);

  assert.deepEqual(tokens.map((token) => [token.symbol, token.balance, token.decimals]), [
    ['ZERO', '1000000', 0],
    ['NUM', '1.0', 6],
  ]);
});

test('suspicious token text is flagged and sorted after the native asset', () => {
  const [spam] = parseBlockscoutTokenBalances([
    { value: '1', token: { address_hash: '0x1111111111111111111111111111111111111111', decimals: '0', symbol: 'CLAIM', name: 'Visit https://bad.example to claim reward', type: 'ERC-20' } },
  ], ethereum);
  const native = nativeAsset(ethereum, '1000000000000000000', 18);

  assert.equal(spam.risk, 'spam');
  assert.deepEqual(visiblePortfolioAssets([spam, native]).map((asset) => asset.id), [
    'evm:1:native',
    'evm:1:0x1111111111111111111111111111111111111111',
  ]);
});

test('prices are keyed by chain and contract rather than symbol', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    coins: {
      'ethereum:0x1111111111111111111111111111111111111111': {
        price: 2,
        symbol: 'SAME',
        timestamp: Math.floor(Date.now() / 1000),
        confidence: 0.99,
      },
    },
  }), { status: 200 });
  const base: Omit<PortfolioAsset, 'address' | 'id'> = {
    family: 'evm', chainKey: 'evm:1', symbol: 'SAME', name: 'Same', balance: '3', rawBalance: '3', decimals: 0, native: false, risk: 'unknown',
  };
  const priced = await attachUsdPrices([
    { ...base, id: 'one', address: '0x1111111111111111111111111111111111111111' },
    { ...base, id: 'two', address: '0x2222222222222222222222222222222222222222' },
  ]);

  assert.equal(priced[0].valueUsd, 6);
  assert.equal(priced[1].priceUsd, undefined);
});

test('stale prices do not become portfolio values', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    coins: {
      'coingecko:ethereum': { price: 2500, symbol: 'ETH', timestamp: Math.floor(Date.now() / 1000) - 7200 },
    },
  }), { status: 200 });

  const [asset] = await attachUsdPrices([nativeAsset(ethereum, '1000000000000000000', 18)]);
  assert.equal(asset.priceUsd, undefined);
  assert.equal(asset.valueUsd, undefined);
});

test('Arc displays native USDC once with 18 decimals, without removing other-chain tokens', () => {
  const payload = [
    { value: '1000000', token: { address_hash: '0x3600000000000000000000000000000000000000', decimals: '6', symbol: 'USDC', name: 'USDC', type: 'ERC-20' } },
    { value: '2000000', token: { address_hash: '0x1111111111111111111111111111111111111111', decimals: '6', symbol: 'EURC', name: 'EURC', type: 'ERC-20' } },
  ];
  for (const id of [5042, 5042002]) {
    const chain = evmChain(id);
    assert.equal(chain.symbol, 'USDC');
    const native = nativeAsset(chain, '1000000000000000001', 18);
    assert.equal(native.balance, '1.000000000000000001');
    const tokens = parseBlockscoutTokenBalances(payload, chain);
    assert.deepEqual(tokens.map((token) => token.symbol), ['EURC']);
    assert.equal(visiblePortfolioAssets([native, ...tokens]).length, 2);
  }
  assert.equal(evmChain(5042002).testnet, true);
  assert.equal(parseBlockscoutTokenBalances(payload, ethereum).length, 2);
});

test('Arc mainnet USDC uses its own price and testnet has no real USD valuation', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /coingecko%3Ausd-coin/);
    return new Response(JSON.stringify({ coins: {
      'coingecko:usd-coin': { price: 0.999, timestamp: Math.floor(Date.now() / 1000) },
    } }));
  };
  const [mainnet, testnet] = await attachUsdPrices([
    nativeAsset(evmChain(5042), '2000000000000000000', 18),
    nativeAsset(evmChain(5042002), '2000000000000000000', 18),
  ]);
  assert.equal(mainnet.valueUsd, 1.998);
  assert.equal(testnet.priceUsd, undefined);
});

test('Arc automatic discovery is explicitly unsupported rather than querying an authenticated explorer', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('Unexpected explorer request'); };
  for (const id of [5042, 5042002]) {
    await assert.rejects(discoverEvmTokens(evmChain(id), '0x1111111111111111111111111111111111111111'), /Automatic token discovery is unavailable/);
  }
});

test('Robinhood does not query broken explorers, pay for APIs, or scan chain history', async context => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  await assert.rejects(discoverEvmTokens(evmChain(4663), '0x1111111111111111111111111111111111111111'), /Robinhood automatic token discovery is currently unavailable/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('discovery distinguishes a valid empty result from HTTP, HTML and envelope failures', async context => {
  const address = '0x1111111111111111111111111111111111111111';
  for (const response of [
    new Response('<html>Just a moment...</html>', { status: 403 }),
    new Response('<html>Just a moment...</html>'),
    Response.json({ error: 'indexer unavailable' }),
    Response.json({ data: [], next_cursor: 'next-page' }),
    Response.json(null),
  ]) {
    const mock = context.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(discoverEvmTokens(ethereum, address));
    mock.mock.restore();
  }
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), `https://eth.blockscout.com/api/v2/addresses/${address}/token-balances`);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    return Response.json([]);
  });
  assert.deepEqual(await discoverEvmTokens(ethereum, address), []);
});

test('oversized discovery results fail instead of silently truncating the portfolio', async context => {
  assert.throws(() => parseBlockscoutTokenBalances(Array(501).fill(null), ethereum), /token limit/);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  context.mock.method(globalThis, 'fetch', async () => new Response(stream));
  await assert.rejects(discoverEvmTokens(ethereum, '0x1111111111111111111111111111111111111111'), /too large/);
  assert.equal(cancelled, true);
});

test('failed token refresh preserves cached balances with a stale marker and respects fresh zero', () => {
  const [oldToken, zeroToken] = parseBlockscoutTokenBalances([
    { value: '123456789012345678901', token: { address_hash: '0x1111111111111111111111111111111111111111', decimals: '18', type: 'ERC-20', symbol: 'OLD' } },
    { value: '1000', token: { address_hash: '0x2222222222222222222222222222222222222222', decimals: '6', type: 'ERC-20', symbol: 'ZERO' } },
  ], ethereum);
  const native = nativeAsset(ethereum, '123', 18);
  const foreign = { ...oldToken, id: 'evm:8453:foreign', chainKey: 'evm:8453' };
  const current = [native, { ...zeroToken, balance: '0.0', rawBalance: '0' }];
  const result = retainUnrefreshedTokens(current, [native, oldToken, zeroToken, foreign], ethereum.key);
  assert.equal(result.length, 3);
  assert.equal(result[1].rawBalance, '0');
  assert.equal(result[1].balanceStale, undefined);
  assert.equal(result[2].rawBalance, '123456789012345678901');
  assert.equal(result[2].balanceStale, true);
  assert.equal(oldToken.balanceStale, undefined);
  assert.deepEqual(retainUnrefreshedTokens(current, [], ethereum.key), current);
});
