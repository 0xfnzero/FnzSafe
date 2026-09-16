import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChainInfo, PortfolioAsset } from '../src/types';
import { evmChain } from '../src/chains';
import {
  attachUsdPrices,
  discoverEvmTokens,
  nativeAsset,
  parseBlockscoutTokenBalances,
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
