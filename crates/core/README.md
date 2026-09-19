# fnzero-safe-core

Solana wallet key management for [FnzSafe](https://github.com/0xfnzero/FnzSafe): Argon2id + AES-256-GCM keystores, mnemonic / private-key import, bot helpers, and an optional interactive CLI.

```toml
fnzero-safe-core = "0.1.8"
```

## Library

```rust
use fnzero_safe::bot_helper::unlock_wallet;

let keypair = unlock_wallet("/path/to/solana-keystore.json")?;
```

## CLI (feature `full`)

```bash
cargo run -p fnzero-safe-core --features full -- start
```

See the [repository README](https://github.com/0xfnzero/FnzSafe) for desktop/mobile wallet docs.

## Related crates

| Crate | Role |
|---|---|
| [`fnzero-safe-chain-core`](https://crates.io/crates/fnzero-safe-chain-core) | Shared chain adapter traits |
| [`fnzero-safe-evm-services`](https://crates.io/crates/fnzero-safe-evm-services) | EVM keystore unlock / signing |
