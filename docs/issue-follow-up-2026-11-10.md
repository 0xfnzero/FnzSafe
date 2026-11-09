# Issue follow-up — 2026-11-10

## #6: optional Base second risk signal

`token_security_scan` accepts `secondSignal: "greyridge-preview"` on Base (`network: "8453"`). The default remains `none`. It calls only the free `/gate/swap/preview` and `/chain/token-report/preview` routes, with the exact contract address; it never pays, signs, or follows redirects. No wallet address or key is sent.

The returned `secondSignal` is independent evidence alongside GoPlus. It validates the contract, Base identity, scenario and timestamps; missing/stale/mismatched results and HTTP failures produce `unavailable`/`hold`. Missing tax values stay null. Unverified simulation or missing administrative-control evidence cannot produce `go`. Provider advertising and payment instructions are omitted. The illustrative $100 buy scenario must not be presented as an actual trade simulation or used to authorize transactions.

Live checks of Base WETH (`0x4200000000000000000000000000000000000006`) returned both preview responses. Some tax fields were null; those remain unknown. The Node adapter also returned `available`/`hold` through the existing local system proxy; direct Node connections timed out on this machine. No global proxy settings were changed. Availability and free quotas are controlled by the provider. The optional free integration implements the suggestion; unlimited paid simulations are deliberately outside its scope.

## #8: Robinhood automatic ERC-20 discovery remains blocked

Read-only checks using the public address in the issue reproduced these results:

- The old `explorer.mainnet.chain.robinhood.com` endpoint fails TLS.
- The official `robinhoodchain.blockscout.com` v2 endpoints return HTTP 403 with a Cloudflare challenge.
- The Blockscout gateway `api.blockscout.com/4663/api/v2/...` returns HTTP 402 requiring an API key or x402 payment.
- HoodScan's documented `get_address` MCP tool returns an indexer error for both the reported address and a second public test address.
- The official RPC rejects a full-history `eth_getLogs` query: only 30,000 blocks are allowed per unscoped-contract request; the current chain has over 110 million blocks. Exhaustive foreground scanning would require thousands of requests and is not an acceptable wallet-refresh implementation.

Consequently, automatic Robinhood discovery remains explicitly unavailable and #8 must stay open. Manually added ERC-20 contracts continue to use the selected RPC. No paid service, new key requirement, exhaustive scan, or challenge bypass has been introduced.

Related failure handling is fixed: malformed JSON/envelopes and over-limit lists cannot masquerade as an empty successful portfolio; response bodies are bounded while streaming. On an EVM token-refresh failure, missing tokens from the same account/network/RPC/privacy cache entry keep their last balances and are marked stale. Fresh values, including zero, win. A successful empty discovery still clears absent tokens. This is an in-memory cache safeguard, not recovery after clearing browser storage or restarting the service worker.

Closing #8 requires a verified wallet-address token index accessible to the extension, or an explicitly configured authenticated index. A domain replacement alone does not satisfy that requirement.
