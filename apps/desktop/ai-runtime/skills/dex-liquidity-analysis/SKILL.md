---
name: dex-liquidity-analysis
description: Analyze DEX pair liquidity, volume, valuation, price changes, and pair age using current DexScreener data.
whenToUse: Use for contract-address market checks, new-token discovery, tradability questions, or suspicious price-move analysis.
---

# DEX Liquidity Analysis

Resolve the exact chain and contract address before comparing pairs. Use `dex_pair_search` for discovery, `token_risk_snapshot` for all indexed pairs of a contract, and `latest_token_profiles` only to discover newly promoted profiles.

Prefer the deepest relevant pair and report DEX, quote asset, liquidity in USD, 24-hour volume, transaction counts, FDV or market cap, pair creation time, and price changes. Treat low liquidity, volume that is implausibly high relative to liquidity, extreme FDV-to-liquidity ratios, one-sided activity, and very new pools as manipulation or execution-risk signals.

DexScreener data is market metadata, not proof of contract safety or holder distribution. Pair it with `token_security_scan` for security-sensitive questions. Never describe a token as safe solely because it has liquidity.
