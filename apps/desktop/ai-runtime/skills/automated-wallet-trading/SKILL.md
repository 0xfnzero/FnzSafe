---
name: automated-wallet-trading
description: Execute an explicitly requested, bounded Solana token sale through an already-unlocked FnzSafe wallet session. Use only for immediate wallet-trading requests, not research, recommendations, transfers, arbitrary signing, or unattended strategy creation.
---

# Automated Wallet Trading

Treat transaction execution as a separate step from research. Resolve the exact Solana mint and venue, then restate the wallet ID, mint, sell percentage, maximum slippage, and that the action submits a real mainnet transaction. Do not infer or silently correct any of these fields.

Use `wallet_session_status` before execution. If the wallet is locked, stop and ask the user to unlock it in FnzSafe; never ask for or accept a password, private key, seed phrase, keystore, session key, or raw signature.

Call `automated_token_sell` only when the current user message explicitly authorizes an immediate sale with all required fields. The tool is limited to Pump.fun or PumpSwap, at most 25% of the token balance per call and at most 5% slippage. Never split a larger request into multiple calls, raise slippage to force execution, substitute another wallet or mint, or retry an error or timeout automatically. A timeout may mean the transaction was submitted; tell the user to inspect transaction history before taking another action.

Report success only when the tool returns a transaction signature. This runtime does not support automatic buys, transfers, arbitrary calldata, limit orders, recurring strategies, or background trading; explain that limitation instead of approximating them with another tool.
