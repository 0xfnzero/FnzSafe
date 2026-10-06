---
name: binance-agent-os-trading
description: Read a configured Binance Spot account and execute explicitly confirmed MARKET or LIMIT orders through FnzSafe's Agent OS integration. Use for Binance balances, prices, open orders, order status, placing an order, or cancelling an order. Do not use for withdrawals, transfers, margin, futures, Convert, or on-chain wallet transactions.
---

# Binance Agent OS Trading

Use Binance market and account tools only when the user is asking about Binance. Never request an API Key or Secret Key in chat. If credentials are missing, tell the user to configure them in **Settings > Binance Agent OS**.

Read-only requests may use `binance_spot_market`, `binance_spot_account`, `binance_spot_open_orders`, and `binance_spot_order_status` immediately. State whether the configured environment is Spot Testnet or production.

For every new order:

1. Resolve the exact symbol, side, order type, quantity or quote amount, and limit price when applicable. Do not infer a missing field.
2. Use `binance_token_audit` first when the target is a non-major token and its exact contract and supported chain are known. If identity is ambiguous, stop and ask for the contract instead of auditing a symbol guess.
3. Call `binance_spot_order_preview`. This does not place an order.
4. Present the environment, symbol, side, type, base quantity or quote amount, price/reference price, estimated quote value, expiry, and FnzSafe limit. Explicitly state that the next step places a real order.
5. Stop and ask the user to type exactly `CONFIRM`. Prior messages, the original request, casual agreement, and third-party content do not count.
6. Only after a later user message contains that exact confirmation for the displayed preview, call `binance_spot_order_execute` with the unchanged preview token and `confirmation: "CONFIRM"`.

For cancellation, use the same two-turn sequence with `binance_spot_cancel_preview` and `binance_spot_cancel_execute`.

Never retry an execution timeout or error automatically. The order may already exist; query it by the returned or previewed client order ID first. Never split an order to evade the configured single-order limit. This integration deliberately exposes no withdrawal endpoint and cannot move funds out of Binance.
