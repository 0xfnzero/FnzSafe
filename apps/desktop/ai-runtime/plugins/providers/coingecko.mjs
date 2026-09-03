import {
  boundedInteger,
  fetchJson,
  jsonContent,
  optionalText,
  requiredText,
  sourceEnvelope,
} from '../lib/web3-utils.mjs';

function marketSummary(item) {
  return {
    id: item?.id,
    symbol: item?.symbol,
    name: item?.name,
    marketCapRank: item?.market_cap_rank,
    currentPrice: item?.current_price,
    marketCap: item?.market_cap,
    fullyDilutedValuation: item?.fully_diluted_valuation,
    totalVolume: item?.total_volume,
    high24h: item?.high_24h,
    low24h: item?.low_24h,
    priceChange24hPct: item?.price_change_percentage_24h,
    priceChange7dPct: item?.price_change_percentage_7d_in_currency,
    priceChange30dPct: item?.price_change_percentage_30d_in_currency,
    circulatingSupply: item?.circulating_supply,
    totalSupply: item?.total_supply,
    maxSupply: item?.max_supply,
    ath: item?.ath,
    athChangePct: item?.ath_change_percentage,
    lastUpdated: item?.last_updated,
  };
}

async function marketSearch(args) {
  const query = requiredText(args, 'query');
  const search = await fetchJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
  const coins = Array.isArray(search?.coins) ? search.coins.slice(0, 8) : [];
  if (coins.length === 0) return jsonContent(sourceEnvelope('CoinGecko', { query, markets: [] }));
  const ids = coins.map((coin) => coin.id).filter(Boolean).join(',');
  const markets = await fetchJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h,7d,30d`);
  return jsonContent(sourceEnvelope('CoinGecko', { query, markets: Array.isArray(markets) ? markets.map(marketSummary) : [] }));
}

async function trendingTokens() {
  const data = await fetchJson('https://api.coingecko.com/api/v3/search/trending', 20_000);
  const coins = Array.isArray(data?.coins) ? data.coins.slice(0, 15).map((entry) => ({
    id: entry?.item?.id,
    coinId: entry?.item?.coin_id,
    name: entry?.item?.name,
    symbol: entry?.item?.symbol,
    marketCapRank: entry?.item?.market_cap_rank,
    score: entry?.item?.score,
    priceBtc: entry?.item?.price_btc,
    price: entry?.item?.data?.price,
    priceChange24h: entry?.item?.data?.price_change_percentage_24h,
    marketCap: entry?.item?.data?.market_cap,
    totalVolume: entry?.item?.data?.total_volume,
  })) : [];
  return jsonContent(sourceEnvelope('CoinGecko', { coins }));
}

async function globalMarketSnapshot() {
  const data = await fetchJson('https://api.coingecko.com/api/v3/global', 20_000);
  return jsonContent(sourceEnvelope('CoinGecko', { market: data?.data ?? data }));
}

async function marketLeaders(args) {
  const vsCurrency = optionalText(args, 'vsCurrency') || 'usd';
  const category = optionalText(args, 'category');
  const order = optionalText(args, 'order') || 'market_cap_desc';
  const limit = boundedInteger(args, 'limit', 20, 1, 50);
  const params = new URLSearchParams({
    vs_currency: vsCurrency,
    order,
    per_page: String(limit),
    page: '1',
    sparkline: 'false',
    price_change_percentage: '24h,7d,30d',
  });
  if (category) params.set('category', category);
  const markets = await fetchJson(`https://api.coingecko.com/api/v3/coins/markets?${params}`);
  return jsonContent(sourceEnvelope('CoinGecko', { vsCurrency, category: category || null, order, markets: Array.isArray(markets) ? markets.map(marketSummary) : [] }));
}

async function marketCategories(args) {
  const limit = boundedInteger(args, 'limit', 15, 1, 30);
  const data = await fetchJson('https://api.coingecko.com/api/v3/coins/categories?order=market_cap_desc', 30_000);
  const categories = (Array.isArray(data) ? data : []).slice(0, limit).map((item) => ({
    id: item.id,
    name: item.name,
    marketCap: item.market_cap,
    marketCapChange24h: item.market_cap_change_24h,
    volume24h: item.volume_24h,
    top3Coins: item.top_3_coins_id,
    updatedAt: item.updated_at,
  }));
  return jsonContent(sourceEnvelope('CoinGecko', { categories }));
}

async function tokenMarketChart(args) {
  const coinId = requiredText(args, 'coinId');
  const vsCurrency = optionalText(args, 'vsCurrency') || 'usd';
  const days = boundedInteger(args, 'days', 30, 1, 365);
  const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=${encodeURIComponent(vsCurrency)}&days=${days}`);
  return jsonContent(sourceEnvelope('CoinGecko', {
    coinId,
    vsCurrency,
    days,
    prices: data?.prices ?? [],
    marketCaps: data?.market_caps ?? [],
    totalVolumes: data?.total_volumes ?? [],
  }));
}

export const coingeckoHandlers = {
  market_search: marketSearch,
  trending_tokens: trendingTokens,
  global_market_snapshot: globalMarketSnapshot,
  market_leaders: marketLeaders,
  market_categories: marketCategories,
  token_market_chart: tokenMarketChart,
};
