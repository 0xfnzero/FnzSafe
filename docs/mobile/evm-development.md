# FnzeroSafe Mobile EVM Development Notes

## Scope

FnzeroSafe treats EVM support as one generic wallet flow driven by `chain_id`,
`rpc_url`, `explorer_url`, and `native_symbol`. Built-in chains and user-defined
chains use the same Rust services and Flutter UI.

Mobile EVM v1 supports EOA wallets, native transfers, ERC-20 transfers, asset
refresh, transaction status, and EIP-1193 dApp signing. It does not include
Safe{Wallet} multisig, swaps, bridges, staking, NFT-specific UI, contract
deployment, or arbitrary contract write forms.

Solana Program deploy, upgrade, source build, and generic Program invoke remain
desktop-only and must not be added to the mobile bridge.

## Preview, Confirm, Submit

Every signing or submit path must follow the same two-step shape:

1. Preview builds a human-reviewable request with chain, wallet, recipient,
   token, amount, gas, nonce, dApp origin, and warnings.
2. Confirm is the only place that can unlock the keystore, run biometric
   confirmation, sign, or submit.
3. Reject returns a structured `UserRejected` error and never signs silently.

Flutter screens call the `MobileBridge` facade. They should not construct raw
EVM transactions or ABI calldata directly.

## Custom Chains

Custom EVM chains are stored on-device as non-sensitive metadata:

- chain id
- chain name
- native token symbol
- RPC URL
- optional explorer URL
- testnet flag

If a custom chain has the same chain id as a built-in chain, the custom entry
overrides the built-in RPC/explorer settings for that device.

## Custom ERC-20 Tokens

Custom ERC-20 token contracts are stored per chain and wallet address. Asset
refresh passes those contracts to Rust, and Rust queries `balanceOf`,
`decimals`, `symbol`, and `name`.

Token metadata is treated as untrusted remote data. UI should display it, but
signing confirmations must prioritize contract address and chain id.

## Transaction History

Rust loads recent EVM transactions through an Etherscan-compatible explorer API
when `explorer_url` is configured. If no compatible explorer is available, asset
refresh still succeeds and returns:

- `history_status = "unsupported"` for chains without compatible history
- `history_status = "unavailable"` for temporary explorer/API failure
- `history_status = "ok"` when history was queried successfully

Explorer history is informational. Transaction submission and receipt status use
RPC calls.

## Sensitive Data

Passwords, private keys, mnemonics, and TOTP secrets must not be logged, stored
in persistent Dart state, or included in user-facing error text. Keystore JSON is
stored in the app private directory; wallet metadata, active wallet id, custom
chains, and custom token contracts may be stored in secure storage.
