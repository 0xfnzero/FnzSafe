import {
  boundedInteger,
  fetchJson,
  jsonContent,
  optionalText,
  requiredText,
  sourceEnvelope,
} from '../lib/web3-utils.mjs';

function pairSummary(item) {
  return {
    chainId: item?.chainId,
    dexId: item?.dexId,
    url: item?.url,
    pairAddress: item?.pairAddress,
    labels: item?.labels,
    baseToken: item?.baseToken,
    quoteToken: item?.quoteToken,
    priceNative: item?.priceNative,
    priceUsd: item?.priceUsd,
    liquidity: item?.liquidity,
    fdv: item?.fdv,
    marketCap: item?.marketCap,
    volume: item?.volume,
    txns: item?.txns,
    priceChange: item?.priceChange,
    pairCreatedAt: item?.pairCreatedAt,
    boosts: item?.boosts,
    websites: item?.info?.websites,
    socials: item?.info?.socials,
  };
}

function validateSecurityAddress(address, network) {
  const valid = network === 'solana'
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(address)
    : /^0x[0-9a-fA-F]{40}$/u.test(address);
  if (!valid) throw new Error(`address is not valid for ${network}`);
}

async function dexPairSearch(args) {
  const query = requiredText(args, 'query');
  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
  const pairs = Array.isArray(data?.pairs) ? data.pairs.slice(0, 20).map(pairSummary) : [];
  return jsonContent(sourceEnvelope('DexScreener', { query, pairs }));
}

async function tokenRiskSnapshot(args) {
  const address = requiredText(args, 'address');
  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
  const pairs = Array.isArray(data?.pairs) ? data.pairs.slice(0, 20).map(pairSummary) : [];
  return jsonContent(sourceEnvelope('DexScreener', { address, pairs }));
}

async function latestTokenProfiles(args) {
  const chain = optionalText(args, 'chain').toLowerCase();
  const limit = boundedInteger(args, 'limit', 15, 1, 30);
  const data = await fetchJson('https://api.dexscreener.com/token-profiles/latest/v1');
  const profiles = (Array.isArray(data) ? data : [])
    .filter((item) => !chain || String(item?.chainId || '').toLowerCase() === chain)
    .slice(0, limit);
  return jsonContent(sourceEnvelope('DexScreener', {
    chain: chain || null,
    profiles,
    caution: 'Token profiles are promotional discovery records and are not endorsements or proof of safety.',
  }));
}

async function tokenSecurityScan(args) {
  const address = requiredText(args, 'address');
  const network = requiredText(args, 'network').toLowerCase();
  validateSecurityAddress(address, network);
  if (network === 'solana') {
    const report = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report/summary`);
    return jsonContent(sourceEnvelope('Rugcheck', { network, address, report, limitation: 'Automated snapshot only; not a complete source-code audit.' }));
  }
  const normalizedAddress = address.toLowerCase();
  const data = await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${network}?contract_addresses=${encodeURIComponent(normalizedAddress)}`);
  const record = data?.result?.[normalizedAddress] ?? Object.values(data?.result ?? {})[0] ?? null;
  const security = record ? {
    tokenName: record.token_name,
    tokenSymbol: record.token_symbol,
    holderCount: record.holder_count,
    totalSupply: record.total_supply,
    creatorAddress: record.creator_address,
    creatorPercent: record.creator_percent,
    ownerAddress: record.owner_address,
    ownerPercent: record.owner_percent,
    buyTax: record.buy_tax,
    sellTax: record.sell_tax,
    isOpenSource: record.is_open_source,
    isProxy: record.is_proxy,
    isMintable: record.is_mintable,
    isHoneypot: record.is_honeypot,
    hiddenOwner: record.hidden_owner,
    canTakeBackOwnership: record.can_take_back_ownership,
    ownerChangeBalance: record.owner_change_balance,
    selfdestruct: record.selfdestruct,
    externalCall: record.external_call,
    cannotSellAll: record.cannot_sell_all,
    tradingCooldown: record.trading_cooldown,
    transferPausable: record.transfer_pausable,
    topHolders: Array.isArray(record.holders) ? record.holders.slice(0, 10) : [],
    dex: Array.isArray(record.dex) ? record.dex.slice(0, 10) : [],
  } : null;
  return jsonContent(sourceEnvelope('GoPlus', { network, address, security, limitation: 'Automated snapshot only; not a complete source-code audit.' }));
}

export const dexSecurityHandlers = {
  dex_pair_search: dexPairSearch,
  token_risk_snapshot: tokenRiskSnapshot,
  latest_token_profiles: latestTokenProfiles,
  token_security_scan: tokenSecurityScan,
};
