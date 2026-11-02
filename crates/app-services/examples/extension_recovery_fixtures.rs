//! Generate public, synthetic desktop backup fixtures for extension compatibility tests.
//! Run with one output path. NEVER use these accounts for real assets.
use fnzero_safe::KeyManager;
use fnzero_safe_evm_services::{
    import_mnemonic, import_private_key, EvmImportMnemonicRequest, EvmImportPrivateKeyRequest,
};
use serde_json::json;
use solana_sdk::signer::Signer;
fn main() {
    let output = std::env::args().nth(1).expect("output JSON path");
    let password = "local-fixture-password";
    let phrase = "test test test test test test test test test test test junk";
    let evm_key = import_private_key(EvmImportPrivateKeyRequest {
        name: "Public fixture".into(),
        private_key_hex: format!("{:064}", 1),
        password: password.into(),
    })
    .unwrap();
    let evm_phrase = import_mnemonic(EvmImportMnemonicRequest {
        name: "Public fixture".into(),
        mnemonic: phrase.into(),
        derivation_path: Some("m/44'/60'/0'/0/1".into()),
        password: password.into(),
    })
    .unwrap();
    let path = "m/44'/501'/0'/0'";
    let solana = KeyManager::keypair_from_mnemonic(phrase, path).unwrap();
    let fixtures = json!([
        {"name":"desktop-evm-key", "family":"evm", "expected_address":evm_key.wallet.address, "text":evm_key.keystore_json},
        {"name":"desktop-evm-mnemonic-custom-path", "family":"evm", "expected_address":evm_phrase.wallet.address, "text":evm_phrase.keystore_json},
        {"name":"desktop-solana-key", "family":"solana", "expected_address":solana.pubkey().to_string(), "text":KeyManager::keypair_to_encrypted_json(&solana,password).unwrap()},
        {"name":"desktop-solana-mnemonic", "family":"solana", "expected_address":solana.pubkey().to_string(), "text":KeyManager::mnemonic_to_encrypted_json(phrase,path,password).unwrap()},
        {"name":"desktop-encrypted-phrase", "family":"solana", "expected_address":solana.pubkey().to_string(), "text":KeyManager::encrypt_secret_with_password(phrase,password).unwrap()}
    ]);
    std::fs::write(
        output,
        serde_json::to_string_pretty(&fixtures).unwrap() + "\n",
    )
    .unwrap();
}
