# FnzSafe Chrome Extension

Manifest V3 wallet extension for EVM and Solana. Bitcoin and TRON are visible in the chain catalog but remain read-only until their transaction signing and broadcast implementations are complete.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Load `apps/extension/dist` as an unpacked extension from `chrome://extensions`.

## Security model

- The vault is encrypted with PBKDF2-SHA-256 (600,000 iterations) and AES-256-GCM before storage.
- Decrypted keys exist only in the Manifest V3 service worker and are cleared after five minutes, explicit lock, or worker suspension.
- Page scripts never receive private keys or the wallet password.
- A content-script bridge validates top-level HTTPS/localhost origins before forwarding provider requests.
- EVM and Solana permissions are recorded per origin and per chain family.
- DApp permissions are bound to the exact origin, selected account, and approved networks, and can be revoked per site.
- Connections, signatures and transactions use a separate confirmation window.
- EVM transactions are chain/account bound, simulated before signing, and decoded for common ERC-20, NFT approval, Permit and Permit2 risks.
- Solana transactions are signer-bound, decoded to show fee payer and programs, and simulated before broadcast.
- Provider messages are size bounded and confirmation queues are rate limited per origin.
- Arbitrary HTTPS dApps are supported, so host access is intentionally broad; the injected page bridge contains no key or password access.
- Enhanced token detection is enabled by default. EVM uses supported address indexers, Solana queries SPL Token and Token-2022 accounts, and USD prices use chain/address keys rather than token symbols.
- Google login and social recovery are intentionally disabled. They may only be enabled with OAuth authorization-code PKCE, strict redirect allowlisting, an audited MPC/threshold-key provider, and a documented recovery policy. OAuth identity must never be used as a private key or bypass local transaction confirmation.

This implementation follows public wallet interaction conventions such as EIP-1193 and EIP-6963. It does not copy MetaMask source code, branding, or visual assets.

The five-minute in-memory vault reduces exposure but cannot guarantee JavaScript string zeroization. Hardware-backed or native isolated signing remains a required hardening step before treating the extension as suitable for high-value custody.
