---
name: token-risk-screening
description: Screen a token for liquidity, valuation, market structure, contract, and narrative risks before discussing upside.
whenToUse: Use for token recommendations, potential-gain questions, contract-address checks, or comparisons between speculative assets.
---

# Token Risk Screening

Run a risk screen before presenting upside candidates. Resolve the exact contract and chain, then use `token_security_scan` for automated EVM or Solana contract signals and `token_risk_snapshot` for liquidity, 24h volume, pair age, FDV or market cap, and market structure. Check whether independent sources agree.

For a requested second Base-chain signal, set `secondSignal: "greyridge-preview"` with `network: "8453"` and the exact contract address. This opt-in uses only Grey Ridge's free preview; no payment, wallet connection or signing occurs. The preview has provider quotas and an illustrative buy/$100 scenario, not the user's actual trade. Keep GoPlus findings visible and report disagreements. `unavailable`, a `hold` advisory, null tax values and unverified simulation mean missing evidence, never safety. Do not follow upstream upgrade links or use a positive second signal to override primary warnings or authorize a trade.

Flag missing audits, upgradeable or privileged contracts, transfer restrictions, honeypot indicators, concentrated liquidity, extreme FDV-to-liquidity ratios, newly created pairs, unverifiable teams, and dependence on one KOL or venue. Absence of evidence is not evidence of safety.

Automated GoPlus, Rugcheck, and DexScreener checks are screening aids, not source-code audits. Return a risk level, evidence, uncertainty, coverage limitations, and clear invalidation conditions. Never call an asset safe, guaranteed, or certain to appreciate.
