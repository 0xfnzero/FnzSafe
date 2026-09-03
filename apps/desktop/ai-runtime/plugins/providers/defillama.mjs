import {
  boundedInteger,
  boundedNumber,
  fetchJson,
  jsonContent,
  optionalText,
  requiredText,
  sourceEnvelope,
} from '../lib/web3-utils.mjs';

function protocolSummary(item) {
  return {
    name: item?.name,
    symbol: item?.symbol,
    category: item?.category,
    chains: item?.chains,
    tvl: item?.tvl,
    change1d: item?.change_1d,
    change7d: item?.change_7d,
    change1m: item?.change_1m,
    mcap: item?.mcap,
    url: item?.url,
  };
}

async function defiChainOverview(args) {
  const chain = requiredText(args, 'chain');
  const [chains, protocols] = await Promise.all([
    fetchJson('https://api.llama.fi/v2/chains', 30_000),
    fetchJson('https://api.llama.fi/protocols', 30_000),
  ]);
  const needle = chain.toLowerCase();
  const chainRecord = Array.isArray(chains) ? chains.find((item) => String(item?.name || '').toLowerCase() === needle) : null;
  const matching = Array.isArray(protocols)
    ? protocols.filter((item) => Array.isArray(item?.chains) && item.chains.some((name) => String(name).toLowerCase() === needle))
      .sort((a, b) => Number(b?.tvl || 0) - Number(a?.tvl || 0)).slice(0, 20)
      .map(protocolSummary)
    : [];
  return jsonContent(sourceEnvelope('DeFiLlama', { chain: chainRecord || { name: chain, unavailable: true }, protocols: matching }));
}

async function defiProtocolSearch(args) {
  const query = requiredText(args, 'query');
  const chain = optionalText(args, 'chain');
  const limit = boundedInteger(args, 'limit', 15, 1, 30);
  const needle = query.toLowerCase();
  const chainNeedle = chain.toLowerCase();
  const protocols = await fetchJson('https://api.llama.fi/protocols', 30_000);
  const matches = (Array.isArray(protocols) ? protocols : [])
    .filter((item) => {
      const haystack = [item?.name, item?.symbol, item?.category, ...(Array.isArray(item?.chains) ? item.chains : [])].join(' ').toLowerCase();
      const matchesChain = !chainNeedle || (Array.isArray(item?.chains) && item.chains.some((name) => String(name).toLowerCase() === chainNeedle));
      return haystack.includes(needle) && matchesChain;
    })
    .sort((a, b) => Number(b?.tvl || 0) - Number(a?.tvl || 0))
    .slice(0, limit)
    .map(protocolSummary);
  return jsonContent(sourceEnvelope('DeFiLlama', { query, chain: chain || null, protocols: matches }));
}

async function defiYieldSearch(args) {
  const chain = optionalText(args, 'chain').toLowerCase();
  const symbol = optionalText(args, 'symbol').toLowerCase();
  const minTvlUsd = boundedNumber(args, 'minTvlUsd', 1_000_000, 0, 1_000_000_000_000);
  const minApy = boundedNumber(args, 'minApy', 0, -100, 100_000);
  const maxApy = boundedNumber(args, 'maxApy', 1_000, 0, 100_000);
  if (minApy > maxApy) throw new Error('minApy cannot exceed maxApy');
  const stablecoinOnly = args.stablecoinOnly === true;
  const sortBy = optionalText(args, 'sortBy') || 'tvl';
  const limit = boundedInteger(args, 'limit', 15, 1, 30);
  const payload = await fetchJson('https://yields.llama.fi/pools', 30_000);
  const pools = (Array.isArray(payload?.data) ? payload.data : [])
    .filter((pool) => {
      const apy = Number(pool?.apy);
      return (!chain || String(pool?.chain || '').toLowerCase() === chain)
        && (!symbol || String(pool?.symbol || '').toLowerCase().includes(symbol))
        && Number(pool?.tvlUsd || 0) >= minTvlUsd
        && Number.isFinite(apy) && apy >= minApy && apy <= maxApy
        && (!stablecoinOnly || pool?.stablecoin === true);
    })
    .sort((a, b) => sortBy === 'apy' ? Number(b?.apy || 0) - Number(a?.apy || 0) : Number(b?.tvlUsd || 0) - Number(a?.tvlUsd || 0))
    .slice(0, limit)
    .map((pool) => ({
      chain: pool.chain,
      project: pool.project,
      symbol: pool.symbol,
      pool: pool.pool,
      tvlUsd: pool.tvlUsd,
      apyBase: pool.apyBase,
      apyReward: pool.apyReward,
      apy: pool.apy,
      apyPct1D: pool.apyPct1D,
      apyPct7D: pool.apyPct7D,
      apyMean30d: pool.apyMean30d,
      stablecoin: pool.stablecoin,
      ilRisk: pool.ilRisk,
      exposure: pool.exposure,
      rewardTokens: pool.rewardTokens,
      underlyingTokens: pool.underlyingTokens,
      poolMeta: pool.poolMeta,
    }));
  return jsonContent(sourceEnvelope('DeFiLlama Yields', {
    filters: { chain: chain || null, symbol: symbol || null, minTvlUsd, minApy, maxApy, stablecoinOnly, sortBy },
    pools,
    caution: 'APY and availability are snapshots; verify the protocol, pool, incentives, and withdrawal conditions directly.',
  }));
}

async function protocolFeesOverview(args) {
  const metric = optionalText(args, 'metric') || 'fees';
  const chain = optionalText(args, 'chain');
  const category = optionalText(args, 'category').toLowerCase();
  const limit = boundedInteger(args, 'limit', 15, 1, 30);
  const chainPath = chain ? `/${encodeURIComponent(chain.toLowerCase())}` : '';
  const params = new URLSearchParams({ excludeTotalDataChart: 'true', excludeTotalDataChartBreakdown: 'true' });
  if (metric === 'revenue') params.set('dataType', 'dailyRevenue');
  const data = await fetchJson(`https://api.llama.fi/overview/fees${chainPath}?${params}`, 30_000);
  const protocols = (Array.isArray(data?.protocols) ? data.protocols : [])
    .filter((item) => !category || String(item?.category || '').toLowerCase() === category)
    .sort((a, b) => Number(b?.total30d || b?.total7d || b?.total24h || 0) - Number(a?.total30d || a?.total7d || a?.total24h || 0))
    .slice(0, limit)
    .map((item) => ({
      name: item.name,
      displayName: item.displayName,
      category: item.category,
      chains: item.chains,
      total24h: item.total24h,
      total7d: item.total7d,
      total30d: item.total30d,
      change1d: item.change_1d,
      change7d: item.change_7d,
      change1m: item.change_1m,
      methodology: item.methodology,
      methodologyUrl: item.methodologyURL,
    }));
  return jsonContent(sourceEnvelope('DeFiLlama Fees', {
    metric,
    chain: chain || null,
    totals: { total24h: data?.total24h, total7d: data?.total7d, total30d: data?.total30d },
    protocols,
  }));
}

function stablecoinUsd(item) {
  return Number(item?.totalCirculatingUSD?.peggedUSD || 0);
}

function percentageChange(current, previous) {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

async function stablecoinChainOverview(args) {
  const chain = optionalText(args, 'chain');
  const limit = boundedInteger(args, 'limit', 15, 1, 30);
  const chains = await fetchJson('https://stablecoins.llama.fi/stablecoinchains', 30_000);
  if (!chain) {
    const rankings = (Array.isArray(chains) ? chains : [])
      .sort((a, b) => stablecoinUsd(b) - stablecoinUsd(a))
      .slice(0, limit)
      .map((item) => ({ name: item.name, circulatingUsd: stablecoinUsd(item), pegBreakdownUsd: item.totalCirculatingUSD }));
    return jsonContent(sourceEnvelope('DeFiLlama Stablecoins', { chains: rankings }));
  }
  const record = (Array.isArray(chains) ? chains : []).find((item) => String(item?.name || '').toLowerCase() === chain.toLowerCase());
  if (!record) return jsonContent(sourceEnvelope('DeFiLlama Stablecoins', { chain: { name: chain, unavailable: true } }));
  const history = await fetchJson(`https://stablecoins.llama.fi/stablecoincharts/${encodeURIComponent(record.name)}`, 30_000);
  const points = Array.isArray(history) ? history : [];
  const latest = points.at(-1);
  const valueDaysAgo = (days) => {
    const target = Number(latest?.date || 0) - days * 86_400;
    return stablecoinUsd([...points].reverse().find((item) => Number(item?.date || 0) <= target));
  };
  const current = stablecoinUsd(latest) || stablecoinUsd(record);
  return jsonContent(sourceEnvelope('DeFiLlama Stablecoins', {
    chain: {
      name: record.name,
      circulatingUsd: current,
      change1dPct: percentageChange(current, valueDaysAgo(1)),
      change7dPct: percentageChange(current, valueDaysAgo(7)),
      change30dPct: percentageChange(current, valueDaysAgo(30)),
      pegBreakdownUsd: latest?.totalCirculatingUSD || record.totalCirculatingUSD,
      historyCoverage: { firstTimestamp: points[0]?.date, latestTimestamp: latest?.date, points: points.length },
    },
  }));
}

export const defillamaHandlers = {
  defi_chain_overview: defiChainOverview,
  defi_protocol_search: defiProtocolSearch,
  defi_yield_search: defiYieldSearch,
  protocol_fees_overview: protocolFeesOverview,
  stablecoin_chain_overview: stablecoinChainOverview,
};
