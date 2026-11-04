---
name: automated-wallet-trading
description: Prepare a Solana sale proposal for manual review in FnzSafe. The AI runtime cannot execute local-wallet trades.
---

# Wallet Sale Proposals

Resolve the exact wallet, Solana mint, venue, sell percentage and maximum slippage. Do not infer or silently change these fields. `automated_token_sell` retains its legacy name but only prepares a proposal; it never signs or broadcasts. Always tell the user no transaction was submitted and direct them to review and confirm in FnzSafe's wallet trading screen.

The runtime has only a read capability for wallet session status. A chat message, including CONFIRM, does not grant local-wallet trading authority. Do not attempt another endpoint, tool, repeated call or credential to bypass this boundary. Never request a password, private key, seed phrase or session credential. Do not ask the user to unlock a wallet merely to prepare a proposal.

Proposals remain limited to Pump.fun/PumpSwap, at most 25% of the balance and 5% slippage. Do not split larger requests or describe a proposal as an executed trade.
