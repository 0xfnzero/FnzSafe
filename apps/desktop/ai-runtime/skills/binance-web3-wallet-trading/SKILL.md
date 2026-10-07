---
name: binance-web3-wallet-trading
description: Use Binance Agentic Wallet for QR sign-in, balances, DEX swap quotes, confirmed market swaps, and BSC or Solana limit orders.
---

# Binance Web3 Wallet Trading

Use the `binance_web3_wallet_*` tools for Binance Agentic Wallet operations. This wallet uses Binance MPC Keyless security and QR sign-in through the Binance App. Never request an API key, API secret, private key, seed phrase, password, session ID, or raw signature for these tools.

Before a wallet operation, call `binance_web3_wallet_status`. If disconnected, call `binance_web3_wallet_signin`, show the official sign-in URL and pairing code, then call `binance_web3_wallet_verify` only after the user approves in the Binance App. Security rules are configured only in the Binance App; use `binance_web3_wallet_settings` and `binance_web3_wallet_quota` to read them.

For a swap, require the exact chain, full source and destination token addresses, source amount, slippage, MEV setting, and gas level. Supported chains are BSC `56`, Ethereum `1`, Base `8453`, and Solana `CT_501`. Resolve unknown token addresses from a reliable source and never infer an address from a symbol. Run `binance_token_audit` for non-native trade tokens before previewing. If the audit is unavailable or reports material risk, stop and explain the result.

Use `binance_web3_swap_quote` for quote-only requests. A real market swap must call `binance_web3_swap_preview`, clearly show the quote, full token addresses, gas, slippage, MEV protection, expiry, and that the next step broadcasts an on-chain transaction. Do not execute in the same turn. Only after the user's next message is exactly `CONFIRM`, call `binance_web3_swap_execute` with the unchanged preview token and confirmation value.

Limit orders are supported only on BSC and Solana. Conditional instructions must use the limit-order tools and must never fall back to an immediate swap. Preview with `binance_web3_limit_order_preview`, show the exact trigger and parameters, and execute only after a later exact `CONFIRM`. Use the list and cancel-preview tools for order management; cancellation also requires a later exact `CONFIRM`.

Never retry a write after an error or timeout. A timeout can mean the request was submitted. Check order or transaction history before suggesting another action. Return success only when the Binance tool reports success, and include the order, strategy, or transaction identifier.
