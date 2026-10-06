---
name: binance-web3-token-audit
description: Query Binance Web3's public token security audit for an exact token contract on Ethereum, BSC, Base, or Solana. Use before a supported token trade or when the user asks whether a token contract shows known risk flags.
---

# Binance Web3 Token Audit

Require an exact contract address and supported chain before calling `binance_token_audit`. Supported chain IDs are Ethereum `1`, BSC `56`, Base `8453`, and Solana `CT_501`. Never guess a contract from a ticker alone.

Only interpret risk fields when both `hasResult` and `isSupported` are true. Show every hit risk item, verification status, and available buy/sell tax values. Treat tax above 5% as a warning and above 10% as high risk. Risk level 5 blocks a FnzSafe-assisted trade; risk level 4 requires a prominent high-risk warning and a new explicit acknowledgment before even creating an order preview.

A low-risk result is not a guarantee of safety. State that the audit is a point-in-time reference, contracts and liquidity can change, and the result is not investment advice.
