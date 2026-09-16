# FnzSafe Mobile EVM Development Notes

## Scope

FnzSafe treats EVM support as one generic wallet flow driven by `chain_id`,
`rpc_url`, `explorer_url`, and `native_symbol`. Built-in chains and user-defined
chains use the same Rust services and Flutter UI.

Arc Mainnet (5042) and Arc Testnet (5042002) reuse Ethereum accounts. Native
USDC and fees use 18 decimals. Its 6-decimal ERC-20 interface at
`0x3600000000000000000000000000000000000000` shares the native balance and is
excluded from duplicate asset rows. Rust applies Arc's 20 Gwei fee floor and
does not fall back to intrinsic gas after failed estimation. Arc history is
unsupported until a system-emitter-aware indexer is integrated; receipt status
and explorer links remain available. Development fallback lists Arc but does
not sign real on-chain transactions.

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

Confirm/submit DTOs must echo the preview wallet address, and Rust must verify
that the decrypted keystore address matches it before signing. Solana and EVM
payment/dApp preview ids are content-bound hashes; submit must reject stale or
mismatched chain/network, wallet, recipient, amount, gas, method, origin,
transaction format, or payload fields.

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
Storage loaders must validate these records and ignore malformed entries rather
than failing app startup or accepting a dApp-provided bad RPC configuration.

## Custom ERC-20 Tokens

Custom ERC-20 token contracts are stored per chain and wallet address. Asset
refresh passes those contracts to Rust, and Rust queries `balanceOf`,
`decimals`, `symbol`, and `name`.

Token metadata is treated as untrusted remote data. UI should display it, but
signing confirmations must prioritize contract address and chain id.
Clients should reject invalid token contracts before saving them, and storage
loaders should ignore entries that are not 20-byte `0x` EVM addresses.

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
Storage loaders for wallet metadata, custom chains, and custom tokens should
ignore malformed records so corrupted local metadata does not block app startup.
