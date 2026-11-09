# Desktop DApp account and network selection

A multichain wallet exposes its Solana provider and EIP-1193/EIP-6963 EVM provider in the embedded DApp browser. Discovering either provider does not authorize an account or change the selected network.

An explicit `wallet_switchEthereumChain` request selects a network already enabled in FnzSafe. For example, `0x61` selects BSC Testnet (`eip155:97`), its configured RPC, and the selected wallet's EVM address even if the wallet UI previously selected Solana. The wallet UI follows the native session without reloading the requesting page. Connecting through the Solana provider selects the wallet's configured Solana network and Solana address.

The connection dialog uses the requested chain's address for both its abbreviated wallet label and its full address preview. The address returned to the DApp uses that same chain-specific lookup.

Only the visible DApp may change networks. Pending connection approvals and pending or in-progress signing requests block a network change. Signing and RPC requests carry the provider's network snapshot; the native bridge rejects stale contexts. Account connection and transaction signing retain their existing approval flows.

The site cannot supply a new RPC through these methods. Known `wallet_addEthereumChain` requests use the wallet's existing configuration; unknown or disabled chains return error 4902 and must first be configured or enabled in wallet settings. FnzSafe does not guess a network from page text, branding, or a URL.

Tests exercise Solana-to-BSC switching, the EVM account returned to the DApp, unknown chains, untrusted RPC parameters, stale account/network contexts, and pending-request/locked/background restrictions. Tests use synthetic wallets and do not sign or broadcast real transactions.
