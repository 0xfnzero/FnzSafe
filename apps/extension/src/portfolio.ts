import { formatUnits } from 'ethers';
import type { ChainInfo, PortfolioAsset } from './types';
import { isNativeTokenAlias } from './chains';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DISCOVERED_TOKENS = 500;
const REQUEST_TIMEOUT_MS = 12_000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const blockscoutBaseUrls: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  10: 'https://optimism.blockscout.com',
  137: 'https://polygon.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  4663: 'https://explorer.mainnet.chain.robinhood.com',
};

const defiLlamaNamespaces: Record<number, string> = {
  1: 'ethereum',
  56: 'bsc',
  10: 'optimism',
  137: 'polygon',
  250: 'fantom',
  324: 'era',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avax',
  59144: 'linea',
  534352: 'scroll',
  4663: 'robinhood',
};

const nativePriceIds: Record<string, string> = {
  'evm:1': 'coingecko:ethereum',
  'evm:56': 'coingecko:binancecoin',
  'evm:10': 'coingecko:ethereum',
  'evm:137': 'coingecko:polygon-ecosystem-token',
  'evm:250': 'coingecko:fantom',
  'evm:324': 'coingecko:ethereum',
  'evm:8453': 'coingecko:ethereum',
  'evm:42161': 'coingecko:ethereum',
  'evm:43114': 'coingecko:avalanche-2',
  'evm:59144': 'coingecko:ethereum',
  'evm:534352': 'coingecko:ethereum',
  'evm:4663': 'coingecko:ethereum',
  'evm:5042': 'coingecko:usd-coin',
  'solana:mainnet-beta': 'coingecko:solana',
  'bitcoin:mainnet': 'coingecko:bitcoin',
  'tron:mainnet': 'coingecko:tron',
};

interface BlockscoutTokenBalance {
  value?: unknown;
  token?: {
    address_hash?: unknown;
    decimals?: unknown;
    name?: unknown;
    symbol?: unknown;
    type?: unknown;
  };
}

interface PricePoint {
  price: number;
  symbol?: string;
  timestamp: number;
  confidence?: number;
}

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function decimalString(rawBalance: string, decimals: number): string {
  try {
    return formatUnits(BigInt(rawBalance), decimals);
  } catch {
    return '0';
  }
}

function tokenRisk(symbol: string, name: string, decimals: number): PortfolioAsset['risk'] {
  const text = `${symbol} ${name}`.toLowerCase();
  if (
    symbol.length > 18 ||
    name.length > 80 ||
    decimals > 36 ||
    /https?:|www\.|visit |claim |reward|airdrop/.test(text)
  ) return 'spam';
  return 'unknown';
}

export function parseBlockscoutTokenBalances(
  raw: unknown,
  chain: ChainInfo,
): PortfolioAsset[] {
  if (!Array.isArray(raw) || chain.family !== 'evm') return [];
  const seen = new Set<string>();
  const assets: PortfolioAsset[] = [];
  for (const entry of raw.slice(0, MAX_DISCOVERED_TOKENS) as BlockscoutTokenBalance[]) {
    const token = entry?.token;
    const address = typeof token?.address_hash === 'string' ? token.address_hash : '';
    const rawBalance = typeof entry?.value === 'string' ? entry.value : '';
    const decimals = Number(token?.decimals);
    if (
      token?.type !== 'ERC-20' ||
      !EVM_ADDRESS.test(address) ||
      !/^\d+$/.test(rawBalance) ||
      BigInt(rawBalance) === 0n ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    ) continue;
    const normalizedAddress = address.toLowerCase();
    if (isNativeTokenAlias(chain.chainId, normalizedAddress)) continue;
    if (seen.has(normalizedAddress)) continue;
    seen.add(normalizedAddress);
    const symbol = boundedText(token.symbol, 'Token', 32);
    const name = boundedText(token.name, symbol, 96);
    assets.push({
      id: `${chain.key}:${normalizedAddress}`,
      family: 'evm',
      chainKey: chain.key,
      address: normalizedAddress,
      symbol,
      name,
      balance: decimalString(rawBalance, decimals),
      rawBalance,
      decimals,
      native: false,
      risk: tokenRisk(symbol, name, decimals),
    });
  }
  return assets;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('response is too large');
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverEvmTokens(
  chain: ChainInfo,
  walletAddress: string,
): Promise<PortfolioAsset[]> {
  if (chain.family !== 'evm' || !chain.chainId || !EVM_ADDRESS.test(walletAddress)) return [];
  const baseUrl = blockscoutBaseUrls[chain.chainId];
  if (!baseUrl) throw new Error(`Automatic token discovery is unavailable for ${chain.name}`);
  const data = await fetchJson(
    `${baseUrl}/api/v2/addresses/${encodeURIComponent(walletAddress)}/token-balances`,
  );
  return parseBlockscoutTokenBalances(data, chain);
}

function priceId(asset: PortfolioAsset): string | null {
  if (asset.native) return nativePriceIds[asset.chainKey] ?? null;
  if (!asset.address) return null;
  if (asset.family === 'solana') return `solana:${asset.address}`;
  if (asset.family !== 'evm') return null;
  const chainId = Number(asset.chainKey.split(':')[1]);
  const namespace = defiLlamaNamespaces[chainId];
  return namespace ? `${namespace}:${asset.address.toLowerCase()}` : null;
}

export async function attachUsdPrices(assets: PortfolioAsset[]): Promise<PortfolioAsset[]> {
  const ids = [...new Set(assets.map(priceId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return assets;
  const prices = new Map<string, PricePoint>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const payload = await fetchJson(
      `https://coins.llama.fi/prices/current/${batch.map(encodeURIComponent).join(',')}`,
    ) as { coins?: Record<string, PricePoint> };
    for (const [id, point] of Object.entries(payload.coins ?? {})) {
      if (Number.isFinite(point?.price) && point.price >= 0 && Number.isFinite(point?.timestamp)) {
        prices.set(id.toLowerCase(), point);
      }
    }
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return assets.map((asset) => {
    const id = priceId(asset);
    const point = id ? prices.get(id.toLowerCase()) : undefined;
    if (!point || point.timestamp > nowSeconds + 300 || nowSeconds - point.timestamp > 60 * 60) return asset;
    const numericBalance = Number(asset.balance);
    const valueUsd = Number.isFinite(numericBalance) ? numericBalance * point.price : undefined;
    return {
      ...asset,
      priceUsd: point.price,
      valueUsd: Number.isFinite(valueUsd) ? valueUsd : undefined,
      priceSource: 'DefiLlama',
      priceUpdatedAt: point.timestamp * 1000,
      symbol: asset.symbol === 'Token' && point.symbol
        ? boundedText(point.symbol, asset.symbol, 32)
        : asset.symbol,
    };
  });
}

export function nativeAsset(
  chain: ChainInfo,
  rawBalance: string,
  decimals: number,
): PortfolioAsset {
  return {
    id: `${chain.key}:native`,
    family: chain.family,
    chainKey: chain.key,
    symbol: chain.symbol,
    name: chain.name,
    balance: decimalString(rawBalance, decimals),
    rawBalance,
    decimals,
    native: true,
    risk: 'verified',
  };
}

export function visiblePortfolioAssets(assets: PortfolioAsset[]): PortfolioAsset[] {
  return assets
    .sort((left, right) => {
      if (left.native !== right.native) return left.native ? -1 : 1;
      if (left.risk !== right.risk) return left.risk === 'spam' ? 1 : -1;
      return (right.valueUsd ?? -1) - (left.valueUsd ?? -1) || left.symbol.localeCompare(right.symbol);
    });
}
