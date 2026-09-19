# fnzero-safe-evm-services

EVM wallet services for [FnzSafe](https://github.com/0xfnzero/FnzSafe): Argon2id + AES-256-GCM keystores, mnemonic/private-key import, unlock helpers for bots and deploy tooling, and chain RPC helpers.

```toml
fnzero-safe-evm-services = "0.1.1"
```

## Unlock a universal or EVM keystore

```rust
use fnzero_safe_evm_services::unlock_private_key_from_document;

let json = std::fs::read_to_string("MyWallet-mnemonic-keystore.json")?;
let (wallet, sk) = unlock_private_key_from_document(&json, "password")?;
println!("address={}", wallet.address);
// `sk` is Zeroizing<Vec<u8>> — never log or persist it.
```

Universal FnzSafe exports that embed `metadata.evm_keystore_json` are accepted directly.
