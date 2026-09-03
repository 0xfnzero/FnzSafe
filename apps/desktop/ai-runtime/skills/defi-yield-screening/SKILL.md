---
name: defi-yield-screening
description: Screen DeFi yield pools by chain, asset, APY, TVL, stablecoin status, exposure, and impermanent-loss metadata.
whenToUse: Use for yield comparisons, stablecoin income questions, farming opportunities, or high-APY risk triage.
---

# DeFi Yield Screening

Use `defi_yield_search` with constraints derived from the user's chain, symbol, minimum liquidity, acceptable APY range, and stablecoin preference. Do not rank solely by APY. Prefer pools with sufficient TVL, understandable reward sources, consistent base yield, and lower dependency on temporary incentives.

For each candidate report project, chain, pool identifier, assets, TVL, base APY, reward APY, total APY, stablecoin flag, exposure, impermanent-loss metadata, and recent APY movement when available. Flag leveraged loops, unaudited protocols, volatile reward tokens, bridge dependencies, depeg risk, withdrawal limits, and implausible outliers.

The dataset is a discovery snapshot, not a guarantee that deposits or withdrawals are available. Never tell the user to deposit without verifying the protocol and pool directly.
