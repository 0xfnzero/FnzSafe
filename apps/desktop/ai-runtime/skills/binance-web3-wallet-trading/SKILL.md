---
name: binance-web3-wallet-trading
description: Use Binance Agentic Wallet for QR sign-in, on-chain trading, Prediction, DeFi, contract calls, EIP-712 signatures, and x402 payments.
---

# Binance Web3 Wallet Trading

Use the `binance_web3_*`, `binance_prediction_*`, `binance_defi_*`, `binance_contract_*`, `binance_sign_*`, and `binance_x402_*` tools for Binance Agentic Wallet operations. The wallet uses Binance MPC Keyless security and QR sign-in through the Binance App. Never request an API key, API secret, private key, seed phrase, password, session ID, or raw signature for these tools.

Before a wallet operation, call `binance_web3_wallet_status`. If disconnected, call `binance_web3_wallet_signin`, show the official sign-in URL and pairing code, then call `binance_web3_wallet_verify` only after the user approves in the Binance App. Security rules are configured only in the Binance App; use `binance_web3_wallet_settings` and `binance_web3_wallet_quota` to read them.

Every state-changing action or signature has two FnzSafe steps. First call the matching `*_preview` tool, explain the exact chain, assets, amounts, recipients or contract, fees/slippage, simulation or quote, expiry, and material risk. Do not execute in the same turn. Only after the user's next message is exactly `CONFIRM`, call the matching `*_execute` tool once with the unchanged preview token. Never retry a write after an error or timeout. A timeout can mean submission succeeded; inspect history before suggesting another action.

## Tokens, transfers, and orders

For a swap, require the exact chain, full source and destination token addresses, source amount, slippage, MEV setting, and gas level. Supported wallet chains are BSC `56`, Ethereum `1`, Base `8453`, and Solana `CT_501`. Resolve unknown token addresses from a reliable source and never infer an address from a symbol. Run `binance_token_audit` for non-native trade tokens before previewing. If the audit is unavailable or reports material risk, stop and explain the result.

Use `binance_web3_swap_quote` for quote-only requests. A real market swap uses `binance_web3_swap_preview` and `binance_web3_swap_execute`. Limit orders are supported only on BSC and Solana. Conditional instructions must use the limit-order tools and must never fall back to an immediate swap. Transfers, limit-order cancellations, EVM pending-transaction cancel/speed-up, token approval revocations, and wallet sign-out follow the same preview and later-confirmation rule.

## Prediction

Use the Prediction market, category, order-book, position, PnL, portfolio, and order-history tools for research. Use `binance_prediction_trade_quote` before any order. Prediction trading supports only BSC `56` and Polygon `137`; Polygon support here does not extend to ordinary wallet or DEX tools. A quote does not place an order.

Place, cancel, and redeem operations require their dedicated preview and execute tools. For limit orders, require `priceLimit`. Show the quote ID, order type, slippage basis points, and price limit before confirmation. Batch cancel and redeem accept at most 20 unique IDs.

## DeFi

Use the protocol and investment tools to compare TVL and APY, then inspect current positions. Treat APY as a current observation, not a promised return. Before a deposit, redeem, LP change, or claim, verify the protocol, investment ID, exact token address, chain, amount or ratio, and gas level.

`binance_defi_action_preview` runs Binance's official simulation before FnzSafe creates its five-minute preview. For LP additions, specify exactly one source: an existing `nftId`, a percentage `priceRange`, or explicit `tickLower` and `tickUpper`. Never silently substitute an LP range. Execute only with the unchanged preview after a later exact `CONFIRM`.

## Contract calls and signatures

Contract calls are advanced operations. For EVM calls, show `from`, `to`, raw wei value, full calldata, decoded method when known, and any explicit gas limit. For Solana, show the signer and a summary of the unsigned transaction; never accept a transaction from a local file path. `binance_contract_call_preview` must successfully simulate and return a Binance request ID before FnzSafe asks for confirmation.

Only EIP-712 typed-data signatures are supported. Explain the domain, chain ID, verifying contract, primary type, and human-readable message fields. Reject opaque or unexplained typed data. The EIP-712 domain chain must match the selected chain. Use the preview and later-confirmation flow, and never print the resulting raw signature unless the user explicitly needs it for the requested protocol flow.

## x402

Use `binance_x402_payment_options` only with a PaymentRequired JSON or base64 JSON payload obtained from the user's requested service. Show the selected chain, asset, amount, payee, approval requirement, and expiry. Signing an x402 option can authorize payment and may dispatch a Permit2 approval, so it requires `binance_x402_payment_sign_preview` and a later exact `CONFIRM` before `binance_x402_payment_sign_execute`.

Return success only when the Binance tool reports success, and include the order, strategy, request, or transaction identifier. Never broaden a request into a different chain, token, protocol action, contract call, or signature.
