---
name: coingecko-market-intelligence
description: Use CoinGecko market, category, trend, and price-history data for current crypto market comparisons.
whenToUse: Use for prices, rankings, market breadth, category rotation, historical performance, or CoinGecko-specific questions.
---

# CoinGecko Market Intelligence

Use `global_market_snapshot` for market breadth, `market_leaders` for comparable assets, `market_categories` for sector rotation, and `token_market_chart` for historical context. Resolve ambiguous names with `market_search` before requesting history. Use `trending_tokens` only as attention data.

Always preserve the CoinGecko asset ID, quote currency, retrieval time, and requested window. Compare like with like. Do not compare a fully diluted valuation with another asset's circulating market cap without labeling the difference. A short price series does not establish a durable trend, and past performance does not imply future returns.

If CoinGecko is rate-limited or a field is null, state that limitation instead of filling the gap from memory.
