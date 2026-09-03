---
name: market-sentiment-analysis
description: Evaluate crypto risk appetite using fear-and-greed history, market breadth, and attention signals without turning sentiment into a trade signal.
whenToUse: Use for market mood, fear or greed, overheating, capitulation, or sentiment-versus-fundamentals questions.
---

# Market Sentiment Analysis

Use `market_sentiment` for the index and recent history, `global_market_snapshot` for market breadth, and `trending_tokens` for attention. Treat each as a different measure: survey or price-derived sentiment, aggregate market structure, and search attention.

Report the observation window and retrieval time. Look for agreement or divergence between indicators. Extreme readings can persist and do not identify a reversal date. Trending status can reflect marketing, controversy, or a recent price move rather than durable demand.

Do not use one sentiment number as a buy or sell instruction. Connect any scenario to liquidity, leverage, catalysts, and explicit invalidation conditions.
