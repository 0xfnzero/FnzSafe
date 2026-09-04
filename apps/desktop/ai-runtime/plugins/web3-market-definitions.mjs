import { integerProperty } from './lib/web3-utils.mjs';

export const web3MarketTools = [
  {
    name: 'wallet_session_status',
    description: 'Check whether one saved wallet has an active in-memory signing session. This never exposes secret material.',
    inputSchema: {
      type: 'object',
      properties: { walletId: { type: 'string', pattern: '^[A-Fa-f0-9]{32}$' } },
      required: ['walletId'],
      additionalProperties: false,
    },
  },
  {
    name: 'automated_token_sell',
    description: 'Execute a bounded Solana mainnet Pump.fun or PumpSwap token sale with an already-unlocked saved wallet. This submits a real transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: { type: 'string', pattern: '^[A-Fa-f0-9]{32}$' },
        mint: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' },
        venue: { type: 'string', enum: ['pumpfun', 'pumpswap'] },
        sellPercentBps: integerProperty(1, 2500),
        slippageBps: integerProperty(1, 500),
      },
      required: ['walletId', 'mint', 'venue', 'sellPercentBps', 'slippageBps'],
      additionalProperties: false,
    },
  },
  {
    name: 'market_search',
    description: 'Search CoinGecko for a token or project and return current market metrics for matching assets.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'trending_tokens',
    description: 'Return the current CoinGecko trending-token list. Use it as discovery data, not an investment recommendation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'global_market_snapshot',
    description: 'Return CoinGecko global crypto market capitalization, volume, dominance, and market-change metrics.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'market_leaders',
    description: 'Return ranked CoinGecko markets with price, market cap, FDV, volume, supply, and multi-window price changes.',
    inputSchema: {
      type: 'object',
      properties: {
        vsCurrency: { type: 'string', minLength: 2, maxLength: 12, default: 'usd' },
        category: { type: 'string', minLength: 1, maxLength: 100 },
        order: { type: 'string', enum: ['market_cap_desc', 'volume_desc', 'market_cap_asc'], default: 'market_cap_desc' },
        limit: integerProperty(1, 50, 20),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'market_categories',
    description: 'Return leading CoinGecko token categories with market cap, volume, and 24-hour market-cap changes.',
    inputSchema: { type: 'object', properties: { limit: integerProperty(1, 30, 15) }, additionalProperties: false },
  },
  {
    name: 'token_market_chart',
    description: 'Return CoinGecko historical price, market-cap, and volume series for an exact CoinGecko coin ID.',
    inputSchema: {
      type: 'object',
      properties: {
        coinId: { type: 'string', minLength: 1, maxLength: 120 },
        vsCurrency: { type: 'string', minLength: 2, maxLength: 12, default: 'usd' },
        days: integerProperty(1, 365, 30),
      },
      required: ['coinId'],
      additionalProperties: false,
    },
  },
  {
    name: 'defi_chain_overview',
    description: 'Return DeFiLlama chain TVL and leading protocols for a named blockchain ecosystem.',
    inputSchema: { type: 'object', properties: { chain: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['chain'], additionalProperties: false },
  },
  {
    name: 'defi_protocol_search',
    description: 'Search DeFiLlama protocols by name, symbol, category, or chain and return current TVL and change metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        chain: { type: 'string', minLength: 1, maxLength: 80 },
        limit: integerProperty(1, 30, 15),
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'defi_yield_search',
    description: 'Filter DeFiLlama yield pools by chain, symbol, APY, TVL, and stablecoin status.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', minLength: 1, maxLength: 80 },
        symbol: { type: 'string', minLength: 1, maxLength: 80 },
        minTvlUsd: { type: 'number', minimum: 0, maximum: 1000000000000, default: 1000000 },
        minApy: { type: 'number', minimum: -100, maximum: 100000, default: 0 },
        maxApy: { type: 'number', minimum: 0, maximum: 100000, default: 1000 },
        stablecoinOnly: { type: 'boolean', default: false },
        sortBy: { type: 'string', enum: ['tvl', 'apy'], default: 'tvl' },
        limit: integerProperty(1, 30, 15),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'protocol_fees_overview',
    description: 'Rank DeFiLlama protocols by fees or revenue, optionally scoped to a chain or category.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['fees', 'revenue'], default: 'fees' },
        chain: { type: 'string', minLength: 1, maxLength: 80 },
        category: { type: 'string', minLength: 1, maxLength: 80 },
        limit: integerProperty(1, 30, 15),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'stablecoin_chain_overview',
    description: 'Return chain-level stablecoin supply rankings or a named chain history with 1-day, 7-day, and 30-day changes.',
    inputSchema: { type: 'object', properties: { chain: { type: 'string', minLength: 1, maxLength: 80 }, limit: integerProperty(1, 30, 15) }, additionalProperties: false },
  },
  {
    name: 'dex_pair_search',
    description: 'Search DexScreener pairs by token, symbol, project, chain, or contract address and return liquidity and activity metrics.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'token_risk_snapshot',
    description: 'Inspect DexScreener liquidity, volume, FDV, pair age, and price changes for a contract address. This is a market-risk screen, not a security audit.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', minLength: 20, maxLength: 128 } }, required: ['address'], additionalProperties: false },
  },
  {
    name: 'latest_token_profiles',
    description: 'Return recently published DexScreener token profiles, optionally filtered by chain. Profiles are promotional discovery data, not endorsements.',
    inputSchema: { type: 'object', properties: { chain: { type: 'string', minLength: 1, maxLength: 80 }, limit: integerProperty(1, 30, 15) }, additionalProperties: false },
  },
  {
    name: 'token_security_scan',
    description: 'Run a read-only GoPlus EVM token or Rugcheck Solana security snapshot. Use numeric EVM chain ID or "solana" as network.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', minLength: 20, maxLength: 128 },
        network: { type: 'string', pattern: '^(solana|[1-9][0-9]{0,7})$' },
      },
      required: ['address', 'network'],
      additionalProperties: false,
    },
  },
  {
    name: 'crypto_news',
    description: 'Return recent public RSS items from CoinDesk, Cointelegraph, and Decrypt, optionally filtered by topic and source.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        source: { type: 'string', enum: ['all', 'coindesk', 'cointelegraph', 'decrypt'], default: 'all' },
        limit: integerProperty(1, 30, 15),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'market_sentiment',
    description: 'Return the current and recent Alternative.me Crypto Fear and Greed Index as a sentiment observation, not a trade signal.',
    inputSchema: { type: 'object', properties: { days: integerProperty(1, 30, 7) }, additionalProperties: false },
  },
];
