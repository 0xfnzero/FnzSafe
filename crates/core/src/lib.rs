//! # FnzSafe
//!
//! A Solana key management library with authenticated password keystores.
//!
//! ## Features
//!
//! - **Simple Encryption**: Password-based encryption for Solana private keys
//! - **Triple-Factor Authentication**: Hardware fingerprint + master password + security question
//! - **2FA Support**: TOTP-based two-factor authentication
//! - **Cross-Platform**: Works on macOS, Linux, and Windows
//!
//! ## Quick Start
//!
//! ```rust
//! use fnzero_safe::{KeyManager, EncryptionResult};
//!
//! // Generate a new Solana keypair
//! let keypair = KeyManager::generate_keypair();
//!
//! // Encrypt with password
//! let encrypted = KeyManager::encrypt_with_password(
//!     &keypair.to_base58_string(),
//!     "my_strong_password"
//! ).unwrap();
//!
//! // Decrypt with password
//! let decrypted = KeyManager::decrypt_with_password(
//!     &encrypted,
//!     "my_strong_password"
//! ).unwrap();
//! ```

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm,
};
use argon2::{Algorithm, Argon2, Block, Params, Version as Argon2Version};
use base64::{engine::general_purpose, Engine};
use ring::digest;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::{Condvar, Mutex, OnceLock};
use zeroize::Zeroizing;

// Re-export modules for advanced usage (conditional compilation)
#[cfg(feature = "2fa")]
pub mod totp;

#[cfg(feature = "2fa")]
pub mod secure_totp;

#[cfg(feature = "2fa")]
pub mod hardware_fingerprint;

#[cfg(feature = "2fa")]
pub mod security_question;

// Interactive menu module - needed for bot integration
pub mod interactive;

// Bot helper module for easy bot integration (no CLI dependency)
pub mod bot_helper;

// Solana operations interactive menu
pub mod operations;

// Solana utilities for token operations
#[cfg(any(
    feature = "solana-ops",
    feature = "mobile-solana-ops",
    feature = "sol-trade-sdk"
))]
pub mod solana_utils;

// Re-export commonly used types
pub use solana_sdk::pubkey::Pubkey;
pub use solana_sdk::signature::{Keypair, Signer};

// ============================================================================
// Core Encryption/Decryption Functions
// ============================================================================

/// Legacy XOR encryption/decryption retained for old non-keystore formats.
/// Do not use this unauthenticated construction for new encrypted data.
fn xor_encrypt_decrypt(data: &[u8], key: &[u8; 32]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());

    // Generate keystream from the key
    let mut keystream = Zeroizing::new(Vec::new());
    let mut i: u32 = 0;
    while keystream.len() < data.len() {
        let mut ctx = digest::Context::new(&digest::SHA256);
        ctx.update(key);
        ctx.update(&i.to_le_bytes());
        let hash = ctx.finish();
        keystream.extend_from_slice(hash.as_ref());
        i += 1;
    }

    // XOR operation
    for (i, &byte) in data.iter().enumerate() {
        result.push(byte ^ keystream[i % keystream.len()]);
    }

    result
}

/// Encrypt a string with the legacy unauthenticated format.
///
/// Returns base64-encoded encrypted data
pub fn encrypt_key(secret_key: &str, encryption_key: &[u8; 32]) -> Result<String, String> {
    let data = secret_key.as_bytes();
    let encrypted = xor_encrypt_decrypt(data, encryption_key);
    Ok(general_purpose::STANDARD.encode(encrypted))
}

/// Decrypt a base64-encoded legacy encrypted string with a 32-byte key.
///
/// Returns the original plaintext string
pub fn decrypt_key(encrypted_data: &str, encryption_key: &[u8; 32]) -> Result<String, String> {
    let decrypted = Zeroizing::new(decrypt_key_to_bytes(encrypted_data, encryption_key)?);
    std::str::from_utf8(decrypted.as_slice())
        .map(ToOwned::to_owned)
        .map_err(|_| "Invalid UTF-8 data in decrypted content".to_string())
}

/// Decrypt to raw bytes (used when plaintext may be base58 string or 64-byte keypair).
pub fn decrypt_key_to_bytes(
    encrypted_data: &str,
    encryption_key: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let ciphertext = general_purpose::STANDARD
        .decode(encrypted_data)
        .map_err(|_| "Invalid encrypted data format".to_string())?;
    Ok(xor_encrypt_decrypt(&ciphertext, encryption_key))
}

/// Strip trailing bytes that are not valid base58 (e.g. 0x00, \n, \r, or non-ASCII).
fn trim_trailing_non_base58(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 {
        let b = bytes[end - 1];
        if b == 0x00 || b == b'\n' || b == b'\r' || b > 127 {
            end -= 1;
        } else {
            break;
        }
    }
    &bytes[..end]
}

/// Minimum password length for encryption/decryption
pub const MIN_PASSWORD_LENGTH: usize = 10;

/// Maximum password size accepted by v2 operations, measured in UTF-8 bytes.
pub const MAX_PASSWORD_LENGTH: usize = 1024;

/// Fixed salt retained exclusively for read compatibility with legacy v1 data.
const PASSWORD_SALT: &[u8] = b"sol-safekey-v1-salt-2025";

/// Derive the legacy v1 key. New password keystores use Argon2id instead.
pub fn generate_encryption_key_simple(password: &str) -> [u8; 32] {
    // Combine password with fixed salt
    let mut salted_password = Zeroizing::new(password.as_bytes().to_vec());
    salted_password.extend_from_slice(PASSWORD_SALT);

    // Hash the salted password using SHA-256
    let hash = digest::digest(&digest::SHA256, &salted_password);

    // Take the first 16 bytes of the hash
    let mut key = [0u8; 32];
    key[0..16].copy_from_slice(&hash.as_ref()[0..16]);

    // Fill the remaining 16 bytes by repeating the first 16 bytes
    // This ensures we have a 32-byte key for compatibility
    key[16..32].copy_from_slice(&hash.as_ref()[0..16]);

    key
}

pub const KEYSTORE_V2_VERSION: u8 = 2;
pub const MAX_KEYSTORE_JSON_BYTES: usize = 128 * 1024;

const KEYSTORE_ENCRYPTION_TYPE: &str = "password_only";
const KEYSTORE_V2_KDF: &str = "argon2id";
const KEYSTORE_V2_CIPHER: &str = "aes-256-gcm";
const KEYSTORE_V2_AAD_DOMAIN: &[u8] = b"sol-safekey-keystore";
const KEYSTORE_V2_ARGON2_MEMORY_KIB: u32 = 64 * 1024;
const KEYSTORE_V2_ARGON2_ITERATIONS: u32 = 3;
const KEYSTORE_V2_ARGON2_PARALLELISM: u32 = 1;
const KEYSTORE_V2_SALT_BYTES: usize = 16;
const KEYSTORE_V2_NONCE_BYTES: usize = 12;
const KEYSTORE_V2_PLAINTEXT_BYTES: usize = 64;
const KEYSTORE_V2_TAG_BYTES: usize = 16;
const KEYSTORE_V2_SALT_BASE64_CHARS: usize = 24;
const KEYSTORE_V2_NONCE_BASE64_CHARS: usize = 16;
const KEYSTORE_V2_CIPHERTEXT_BASE64_CHARS: usize = 108;
const KEYSTORE_V2_MAX_CONCURRENT_KDFS: usize = 2;

struct KeystoreKdfLimiter {
    in_flight: Mutex<usize>,
    available: Condvar,
}

struct KeystoreKdfPermit {
    limiter: &'static KeystoreKdfLimiter,
}

static KEYSTORE_V2_KDF_LIMITER: OnceLock<KeystoreKdfLimiter> = OnceLock::new();

fn acquire_keystore_kdf_permit() -> EncryptionResult<KeystoreKdfPermit> {
    let limiter = KEYSTORE_V2_KDF_LIMITER.get_or_init(|| KeystoreKdfLimiter {
        in_flight: Mutex::new(0),
        available: Condvar::new(),
    });
    let mut in_flight = limiter
        .in_flight
        .lock()
        .map_err(|_| "Keystore KDF concurrency limiter is unavailable".to_string())?;
    while *in_flight >= KEYSTORE_V2_MAX_CONCURRENT_KDFS {
        in_flight = limiter
            .available
            .wait(in_flight)
            .map_err(|_| "Keystore KDF concurrency limiter is unavailable".to_string())?;
    }
    *in_flight += 1;
    Ok(KeystoreKdfPermit { limiter })
}

impl Drop for KeystoreKdfPermit {
    fn drop(&mut self) {
        if let Ok(mut in_flight) = self.limiter.in_flight.lock() {
            *in_flight = in_flight.saturating_sub(1);
            self.limiter.available.notify_one();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeystoreVersion {
    LegacyV1,
    V2,
}

#[derive(Deserialize, Serialize)]
struct KeystoreV2 {
    version: u8,
    public_key: String,
    encryption_type: String,
    crypto: KeystoreCryptoV2,
    created_at: String,
}

#[derive(Deserialize, Serialize)]
struct KeystoreCryptoV2 {
    kdf: String,
    kdf_params: KeystoreKdfParamsV2,
    cipher: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize, Serialize)]
struct KeystoreKdfParamsV2 {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

fn validate_v2_password_for_creation(password: &str) -> EncryptionResult<()> {
    if password.chars().count() < MIN_PASSWORD_LENGTH {
        return Err(format!(
            "Password must contain at least {MIN_PASSWORD_LENGTH} characters"
        ));
    }
    validate_password_size(password)
}

fn validate_password_size(password: &str) -> EncryptionResult<()> {
    if password.len() > MAX_PASSWORD_LENGTH {
        return Err(format!(
            "Password must not exceed {MAX_PASSWORD_LENGTH} UTF-8 bytes"
        ));
    }
    Ok(())
}

fn keystore_v2_aad(public_key: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(KEYSTORE_V2_AAD_DOMAIN.len() + public_key.len() + 3);
    aad.extend_from_slice(KEYSTORE_V2_AAD_DOMAIN);
    aad.push(0);
    aad.push(KEYSTORE_V2_VERSION);
    aad.push(0);
    aad.extend_from_slice(public_key.as_bytes());
    aad
}

fn derive_keystore_v2_key(
    password: &str,
    salt: &[u8; KEYSTORE_V2_SALT_BYTES],
) -> EncryptionResult<Zeroizing<[u8; 32]>> {
    validate_password_size(password)?;
    let _permit = acquire_keystore_kdf_permit()?;
    let params = Params::new(
        KEYSTORE_V2_ARGON2_MEMORY_KIB,
        KEYSTORE_V2_ARGON2_ITERATIONS,
        KEYSTORE_V2_ARGON2_PARALLELISM,
        Some(32),
    )
    .map_err(|_| "Invalid Argon2id parameters".to_string())?;
    let block_count = params.block_count();
    let argon2 = Argon2::new(Algorithm::Argon2id, Argon2Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    let mut memory = Vec::new();
    memory
        .try_reserve_exact(block_count)
        .map_err(|_| "Unable to allocate Argon2id memory".to_string())?;
    memory.resize(block_count, Block::default());
    let mut memory = Zeroizing::new(memory);
    argon2
        .hash_password_into_with_memory(
            password.as_bytes(),
            salt,
            key.as_mut(),
            memory.as_mut_slice(),
        )
        .map_err(|_| "Argon2id key derivation failed".to_string())?;
    Ok(key)
}

fn parse_base58_keypair(private_key: &str) -> EncryptionResult<Keypair> {
    let private_key = private_key.trim();
    if private_key.is_empty() {
        return Err("Private key cannot be empty".to_string());
    }
    let bytes = Zeroizing::new(
        bs58::decode(private_key)
            .into_vec()
            .map_err(|_| "Private key is not valid base58".to_string())?,
    );
    if bytes.len() != KEYSTORE_V2_PLAINTEXT_BYTES {
        return Err("Private key must decode to exactly 64 bytes".to_string());
    }
    Keypair::try_from(bytes.as_slice())
        .map_err(|_| "Private key bytes are invalid or inconsistent".to_string())
}

fn parse_decrypted_keypair(bytes: &[u8]) -> EncryptionResult<Keypair> {
    if bytes.len() == KEYSTORE_V2_PLAINTEXT_BYTES {
        if let Ok(keypair) = Keypair::try_from(bytes) {
            return Ok(keypair);
        }
    }

    let trimmed = trim_trailing_non_base58(bytes);
    let private_key = std::str::from_utf8(trimmed)
        .map_err(|_| "Decrypted private key is not valid UTF-8".to_string())?
        .trim();
    parse_base58_keypair(private_key)
}

fn claimed_public_key(
    value: &serde_json::Value,
    required: bool,
) -> EncryptionResult<Option<Pubkey>> {
    match value.get("public_key") {
        Some(serde_json::Value::String(public_key)) => {
            let parsed = Pubkey::from_str(public_key)
                .map_err(|_| "Keystore public_key is invalid".to_string())?;
            if parsed.to_string() != *public_key {
                return Err("Keystore public_key is not canonical".to_string());
            }
            Ok(Some(parsed))
        }
        Some(_) => Err("Keystore public_key must be a string".to_string()),
        None if required => Err("Keystore is missing public_key".to_string()),
        None => Ok(None),
    }
}

fn decrypt_legacy_keystore(json_data: &str, password: &str) -> EncryptionResult<Keypair> {
    let value: serde_json::Value =
        serde_json::from_str(json_data).map_err(|_| "Invalid JSON format".to_string())?;
    if value
        .get("encryption_type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|encryption_type| encryption_type != KEYSTORE_ENCRYPTION_TYPE)
    {
        return Err("Unsupported legacy keystore encryption_type".to_string());
    }
    let encrypted = value
        .get("encrypted_private_key")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Missing encrypted_private_key field".to_string())?;
    let key = Zeroizing::new(generate_encryption_key_simple(password));
    let plaintext = Zeroizing::new(
        decrypt_key_to_bytes(encrypted, &key)
            .map_err(|error| format!("Legacy keystore decryption failed: {error}"))?,
    );
    let keypair = parse_decrypted_keypair(plaintext.as_slice())
        .map_err(|_| "Legacy keystore password or ciphertext is invalid".to_string())?;
    if let Some(public_key) = claimed_public_key(&value, false)? {
        if keypair.pubkey() != public_key {
            return Err("Legacy keystore public_key does not match decrypted keypair".to_string());
        }
    }
    Ok(keypair)
}

fn encrypt_keystore_v2(keypair: &Keypair, password: &str) -> EncryptionResult<String> {
    use chrono::Utc;

    validate_v2_password_for_creation(password)?;
    let public_key = keypair.pubkey().to_string();
    let mut rng = OsRng;
    let mut salt = [0u8; KEYSTORE_V2_SALT_BYTES];
    rng.fill_bytes(&mut salt);
    let nonce = Aes256Gcm::generate_nonce(&mut rng);
    let key = derive_keystore_v2_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| "AES-256-GCM initialization failed".to_string())?;
    let plaintext = Zeroizing::new(keypair.to_bytes());
    let aad = keystore_v2_aad(&public_key);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_ref(),
                aad: &aad,
            },
        )
        .map_err(|_| "AES-256-GCM encryption failed".to_string())?;

    serde_json::to_string(&KeystoreV2 {
        version: KEYSTORE_V2_VERSION,
        public_key,
        encryption_type: KEYSTORE_ENCRYPTION_TYPE.to_string(),
        crypto: KeystoreCryptoV2 {
            kdf: KEYSTORE_V2_KDF.to_string(),
            kdf_params: KeystoreKdfParamsV2 {
                memory_kib: KEYSTORE_V2_ARGON2_MEMORY_KIB,
                iterations: KEYSTORE_V2_ARGON2_ITERATIONS,
                parallelism: KEYSTORE_V2_ARGON2_PARALLELISM,
                salt: general_purpose::STANDARD.encode(salt),
            },
            cipher: KEYSTORE_V2_CIPHER.to_string(),
            nonce: general_purpose::STANDARD.encode(nonce),
            ciphertext: general_purpose::STANDARD.encode(ciphertext),
        },
        created_at: Utc::now().to_rfc3339(),
    })
    .map_err(|_| "Failed to serialize v2 keystore".to_string())
}

fn decrypt_keystore_v2(json_data: &str, password: &str) -> EncryptionResult<Keypair> {
    let keystore: KeystoreV2 =
        serde_json::from_str(json_data).map_err(|_| "Invalid v2 keystore JSON".to_string())?;
    if keystore.version != KEYSTORE_V2_VERSION {
        return Err(format!("Unsupported keystore version {}", keystore.version));
    }
    if keystore.encryption_type != KEYSTORE_ENCRYPTION_TYPE {
        return Err("Unsupported v2 keystore encryption_type".to_string());
    }
    if keystore.crypto.kdf != KEYSTORE_V2_KDF || keystore.crypto.cipher != KEYSTORE_V2_CIPHER {
        return Err("Unsupported v2 keystore cryptography".to_string());
    }
    if keystore.crypto.kdf_params.memory_kib != KEYSTORE_V2_ARGON2_MEMORY_KIB
        || keystore.crypto.kdf_params.iterations != KEYSTORE_V2_ARGON2_ITERATIONS
        || keystore.crypto.kdf_params.parallelism != KEYSTORE_V2_ARGON2_PARALLELISM
    {
        return Err("Unsupported v2 Argon2id parameters".to_string());
    }

    let expected_public_key = Pubkey::from_str(&keystore.public_key)
        .map_err(|_| "Keystore public_key is invalid".to_string())?;
    if expected_public_key.to_string() != keystore.public_key {
        return Err("Keystore public_key is not canonical".to_string());
    }
    if keystore.crypto.kdf_params.salt.len() != KEYSTORE_V2_SALT_BASE64_CHARS {
        return Err("Keystore salt has an invalid encoded length".to_string());
    }
    if keystore.crypto.nonce.len() != KEYSTORE_V2_NONCE_BASE64_CHARS {
        return Err("Keystore nonce has an invalid encoded length".to_string());
    }
    if keystore.crypto.ciphertext.len() != KEYSTORE_V2_CIPHERTEXT_BASE64_CHARS {
        return Err("Keystore ciphertext has an invalid encoded length".to_string());
    }
    let salt: [u8; KEYSTORE_V2_SALT_BYTES] = general_purpose::STANDARD
        .decode(keystore.crypto.kdf_params.salt.as_bytes())
        .map_err(|_| "Keystore salt is not valid base64".to_string())?
        .try_into()
        .map_err(|_| "Keystore salt has an invalid length".to_string())?;
    let nonce_bytes: [u8; KEYSTORE_V2_NONCE_BYTES] = general_purpose::STANDARD
        .decode(keystore.crypto.nonce.as_bytes())
        .map_err(|_| "Keystore nonce is not valid base64".to_string())?
        .try_into()
        .map_err(|_| "Keystore nonce has an invalid length".to_string())?;
    let ciphertext = general_purpose::STANDARD
        .decode(keystore.crypto.ciphertext.as_bytes())
        .map_err(|_| "Keystore ciphertext is not valid base64".to_string())?;
    if ciphertext.len() != KEYSTORE_V2_PLAINTEXT_BYTES + KEYSTORE_V2_TAG_BYTES {
        return Err("Keystore ciphertext has an invalid length".to_string());
    }

    let key = derive_keystore_v2_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| "AES-256-GCM initialization failed".to_string())?;
    let nonce = aes_gcm::Nonce::from(nonce_bytes);
    let aad = keystore_v2_aad(&keystore.public_key);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "V2 keystore password or authenticated data is invalid".to_string())?,
    );
    if plaintext.len() != KEYSTORE_V2_PLAINTEXT_BYTES {
        return Err("Decrypted v2 keypair has an invalid length".to_string());
    }
    let keypair = Keypair::try_from(plaintext.as_slice())
        .map_err(|_| "Decrypted v2 keypair bytes are invalid".to_string())?;
    if keypair.pubkey() != expected_public_key {
        return Err("V2 keystore public_key does not match decrypted keypair".to_string());
    }
    Ok(keypair)
}

// ============================================================================
// High-Level Key Management API (简单集成用)
// ============================================================================

/// Result type for encryption operations
pub type EncryptionResult<T> = Result<T, String>;

/// Main interface for key management operations
///
/// This is the recommended API for library integration.
/// It provides simple, safe methods for common key operations.
pub struct KeyManager;

impl KeyManager {
    /// Generate a new Solana keypair
    ///
    /// # Example
    ///
    /// ```
    /// use fnzero_safe::KeyManager;
    /// use solana_sdk::signature::Signer;
    ///
    /// let keypair = KeyManager::generate_keypair();
    /// println!("Public key: {}", keypair.pubkey());
    /// ```
    pub fn generate_keypair() -> Keypair {
        Keypair::new()
    }

    /// Encrypt a private key with a password
    ///
    /// # Arguments
    ///
    /// * `private_key` - The private key in base58 string format
    /// * `password` - The password to use for encryption
    ///
    /// # Returns
    ///
    /// A serialized authenticated v2 keystore envelope
    ///
    /// # Example
    ///
    /// ```
    /// use fnzero_safe::KeyManager;
    ///
    /// let keypair = KeyManager::generate_keypair();
    /// let private_key = keypair.to_base58_string();
    ///
    /// let encrypted = KeyManager::encrypt_with_password(
    ///     &private_key,
    ///     "my_password"
    /// ).unwrap();
    /// ```
    pub fn encrypt_with_password(private_key: &str, password: &str) -> EncryptionResult<String> {
        let keypair = parse_base58_keypair(private_key)?;
        encrypt_keystore_v2(&keypair, password)
    }

    /// Decrypt a private key with a password
    ///
    /// # Arguments
    ///
    /// * `encrypted_data` - A v2 envelope or legacy v1 ciphertext
    /// * `password` - The password used for encryption
    ///
    /// # Returns
    ///
    /// The original private key in base58 string format
    ///
    /// # Example
    ///
    /// ```
    /// use fnzero_safe::KeyManager;
    ///
    /// let keypair = KeyManager::generate_keypair();
    /// let private_key = keypair.to_base58_string();
    /// let encrypted = KeyManager::encrypt_with_password(
    ///     &private_key,
    ///     "my_password"
    /// ).unwrap();
    /// let decrypted = KeyManager::decrypt_with_password(
    ///     &encrypted,
    ///     "my_password"
    /// ).unwrap();
    /// assert_eq!(decrypted, private_key);
    /// ```
    pub fn decrypt_with_password(encrypted_data: &str, password: &str) -> EncryptionResult<String> {
        if encrypted_data.trim_start().starts_with('{') {
            return Self::keypair_from_encrypted_json(encrypted_data, password)
                .map(|keypair| keypair.to_base58_string());
        }

        validate_password_size(password)?;
        let key = Zeroizing::new(generate_encryption_key_simple(password));
        let plaintext = Zeroizing::new(decrypt_key_to_bytes(encrypted_data, &key)?);
        parse_decrypted_keypair(plaintext.as_slice()).map(|keypair| keypair.to_base58_string())
    }

    /// Get public key from a private key
    ///
    /// # Arguments
    ///
    /// * `private_key` - Private key in base58 string format
    ///
    /// # Returns
    ///
    /// Public key as a base58 string
    pub fn get_public_key(private_key: &str) -> EncryptionResult<String> {
        parse_base58_keypair(private_key).map(|keypair| keypair.pubkey().to_string())
    }

    /// Encrypt a keypair to a JSON keystore format
    ///
    /// This creates a fnzero-safe v2 password keystore.
    ///
    /// # Arguments
    ///
    /// * `keypair` - The Solana keypair to encrypt
    /// * `password` - The password for encryption
    ///
    /// # Returns
    ///
    /// JSON string containing the encrypted keystore
    pub fn keypair_to_encrypted_json(
        keypair: &Keypair,
        password: &str,
    ) -> EncryptionResult<String> {
        encrypt_keystore_v2(keypair, password)
    }

    /// Detect the supported password-keystore format without decrypting it.
    pub fn keystore_version(json_data: &str) -> EncryptionResult<KeystoreVersion> {
        if json_data.len() > MAX_KEYSTORE_JSON_BYTES {
            return Err("Keystore JSON is too large".to_string());
        }
        let value: serde_json::Value =
            serde_json::from_str(json_data).map_err(|_| "Invalid JSON format".to_string())?;
        let version = value.get("version");
        match version {
            Some(serde_json::Value::Number(number)) if number.as_u64() == Some(2) => {
                if value.get("crypto").is_none() {
                    return Err("V2 keystore is missing crypto".to_string());
                }
                Ok(KeystoreVersion::V2)
            }
            Some(serde_json::Value::Number(number)) if number.as_u64() == Some(1) => {
                if value
                    .get("encrypted_private_key")
                    .and_then(serde_json::Value::as_str)
                    .is_none()
                {
                    return Err("Legacy keystore is missing encrypted_private_key".to_string());
                }
                Ok(KeystoreVersion::LegacyV1)
            }
            None => {
                if value
                    .get("encrypted_private_key")
                    .and_then(serde_json::Value::as_str)
                    .is_none()
                {
                    return Err("Unrecognized keystore format".to_string());
                }
                Ok(KeystoreVersion::LegacyV1)
            }
            Some(_) => Err("Unsupported keystore version".to_string()),
        }
    }

    /// Decrypt a supported v2 keystore, rejecting legacy unauthenticated formats.
    pub fn keypair_from_encrypted_json_v2(
        json_data: &str,
        password: &str,
    ) -> EncryptionResult<Keypair> {
        match Self::keystore_version(json_data)? {
            KeystoreVersion::V2 => decrypt_keystore_v2(json_data, password),
            KeystoreVersion::LegacyV1 => Err(
                "Legacy v1 keystore is not allowed for this operation; migrate it explicitly"
                    .to_string(),
            ),
        }
    }

    /// Decrypt a password keystore. Legacy v1 support is read-only.
    pub fn keypair_from_encrypted_json(
        json_data: &str,
        password: &str,
    ) -> EncryptionResult<Keypair> {
        match Self::keystore_version(json_data)? {
            KeystoreVersion::LegacyV1 => decrypt_legacy_keystore(json_data, password),
            KeystoreVersion::V2 => decrypt_keystore_v2(json_data, password),
        }
    }

    /// Explicitly decrypt a legacy v1 keystore and re-encrypt it as v2.
    pub fn migrate_encrypted_json_to_v2(
        json_data: &str,
        legacy_password: &str,
        new_password: &str,
    ) -> EncryptionResult<String> {
        Self::migrate_encrypted_json_to_v2_with_public_key(json_data, legacy_password, new_password)
            .map(|(json, _)| json)
    }

    /// Explicitly migrate legacy v1 and return the public key verified from plaintext.
    pub fn migrate_encrypted_json_to_v2_with_public_key(
        json_data: &str,
        legacy_password: &str,
        new_password: &str,
    ) -> EncryptionResult<(String, String)> {
        if Self::keystore_version(json_data)? != KeystoreVersion::LegacyV1 {
            return Err("Only legacy v1 keystores can be migrated".to_string());
        }
        let value: serde_json::Value =
            serde_json::from_str(json_data).map_err(|_| "Invalid JSON format".to_string())?;
        let claimed = claimed_public_key(&value, true)?
            .ok_or_else(|| "Legacy keystore is missing public_key".to_string())?;
        let keypair = decrypt_legacy_keystore(json_data, legacy_password)?;
        if keypair.pubkey() != claimed {
            return Err("Legacy keystore public_key does not match decrypted keypair".to_string());
        }
        let verified_public_key = keypair.pubkey().to_string();
        encrypt_keystore_v2(&keypair, new_password).map(|json| (json, verified_public_key))
    }
}

// ============================================================================
// Advanced 2FA Functions (CLI 工具使用，库集成可选)
// ============================================================================

// ============================================================================
// 2FA Functions (only available with "2fa" feature)
// ============================================================================

#[cfg(feature = "2fa")]
/// Derive a TOTP secret from password
///
/// This is used internally for deterministic 2FA key generation.
#[allow(dead_code)]
fn derive_totp_secret_from_password(
    password: &str,
    account: &str,
    issuer: &str,
) -> Result<String, String> {
    use data_encoding::BASE32_NOPAD;
    use ring::pbkdf2;
    use std::num::NonZeroU32;

    let salt = format!("sol-safekey-totp-{}-{}", issuer, account);
    let iterations = NonZeroU32::new(100_000).ok_or("Invalid iteration count")?;

    let mut secret = [0u8; 20]; // 160 bits for TOTP
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt.as_bytes(),
        password.as_bytes(),
        &mut secret,
    );

    Ok(BASE32_NOPAD.encode(&secret))
}

#[cfg(feature = "2fa")]
/// Derive TOTP secret from hardware fingerprint and password
///
/// This creates a deterministic 2FA key bound to specific hardware.
pub fn derive_totp_secret_from_hardware_and_password(
    hardware_fingerprint: &str,
    master_password: &str,
    account: &str,
    issuer: &str,
) -> Result<String, String> {
    use data_encoding::BASE32_NOPAD;
    use ring::pbkdf2;
    use std::num::NonZeroU32;

    let key_material = format!("{}::{}", hardware_fingerprint, master_password);
    let salt = format!("sol-safekey-2fa-{}-{}", issuer, account);
    let iterations = NonZeroU32::new(100_000).ok_or("Invalid iteration count")?;

    let mut secret = [0u8; 20];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt.as_bytes(),
        key_material.as_bytes(),
        &mut secret,
    );

    Ok(BASE32_NOPAD.encode(&secret))
}

#[cfg(feature = "2fa")]
/// Verify a TOTP code
fn verify_current_totp_code(totp_secret: &str, current_code: &str) -> Result<(), String> {
    use crate::totp::{TOTPConfig, TOTPManager};

    let config = TOTPConfig {
        secret: totp_secret.to_string(),
        account: "wallet".to_string(),
        issuer: "FnzSafe".to_string(),
        algorithm: "SHA1".to_string(),
        digits: 6,
        step: 30,
    };

    let totp_manager = TOTPManager::new(config);

    match totp_manager.verify_code(current_code) {
        Ok(true) => Ok(()),
        Ok(false) => Err("验证失败，请检查主密码、安全问题答案或2FA验证码".to_string()),
        Err(e) => Err(format!("验证失败: {}", e)),
    }
}

// ============================================================================
// Triple-Factor Encryption (only available with "2fa" feature)
// ============================================================================

#[cfg(feature = "2fa")]
/// Generate a triple-factor encryption key
///
/// Combines hardware fingerprint + master password + security answer
pub fn generate_triple_factor_key(
    hardware_fingerprint: &str,
    master_password: &str,
    security_answer: &str,
) -> [u8; 32] {
    use ring::pbkdf2;
    use std::num::NonZeroU32;

    let key_material = format!(
        "HW:{}|PASS:{}|QA:{}",
        hardware_fingerprint,
        master_password,
        security_answer.trim().to_lowercase()
    );

    let salt = b"sol-safekey-triple-factor-v1";
    let iterations = NonZeroU32::new(200_000).unwrap();

    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        key_material.as_bytes(),
        &mut key,
    );

    key
}

#[cfg(feature = "2fa")]
/// Encrypt with triple-factor authentication
///
/// Used by CLI for maximum security with device binding.
pub fn encrypt_with_triple_factor(
    private_key: &str,
    twofa_secret: &str,
    hardware_fingerprint: &str,
    master_password: &str,
    question_index: usize,
    security_answer: &str,
) -> Result<String, String> {
    use serde_json::json;

    let encryption_key =
        generate_triple_factor_key(hardware_fingerprint, master_password, security_answer);

    let data_package = json!({
        "private_key": private_key,
        "twofa_secret": twofa_secret,
        "question_index": question_index,
        "version": "triple_factor_v1",
        "created_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    });

    let package_str = data_package.to_string();
    let encrypted = encrypt_key(&package_str, &encryption_key)?;

    Ok(encrypted)
}

#[cfg(feature = "2fa")]
/// Decrypt with triple-factor authentication and verify 2FA code
///
/// Used by CLI for unlocking triple-factor encrypted wallets.
pub fn decrypt_with_triple_factor_and_2fa(
    encrypted_data: &str,
    hardware_fingerprint: &str,
    master_password: &str,
    security_answer: &str,
    twofa_code: &str,
) -> Result<(String, String, usize), String> {
    let decryption_key =
        generate_triple_factor_key(hardware_fingerprint, master_password, security_answer);

    let decrypted = decrypt_key(encrypted_data, &decryption_key)
        .map_err(|_| "解密失败，请检查主密码、安全问题答案是否正确")?;

    let data: serde_json::Value = serde_json::from_str(&decrypted)
        .map_err(|_| "解密失败，请检查主密码、安全问题答案是否正确")?;

    let private_key = data["private_key"]
        .as_str()
        .ok_or("缺少私钥数据")?
        .to_string();

    let twofa_secret = data["twofa_secret"]
        .as_str()
        .ok_or("缺少2FA密钥数据")?
        .to_string();

    let question_index = data["question_index"].as_u64().ok_or("缺少安全问题索引")? as usize;

    // Verify 2FA code
    verify_current_totp_code(&twofa_secret, twofa_code)?;

    Ok((private_key, twofa_secret, question_index))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn legacy_keystore_json(keypair: &Keypair, password: &str, public_key: Option<&str>) -> String {
        let key = Zeroizing::new(generate_encryption_key_simple(password));
        let private_key = Zeroizing::new(keypair.to_base58_string());
        let encrypted = encrypt_key(private_key.as_str(), &key).unwrap();
        let mut value = json!({
            "encrypted_private_key": encrypted,
            "encryption_type": KEYSTORE_ENCRYPTION_TYPE,
        });
        if let Some(public_key) = public_key {
            value["public_key"] = serde_json::Value::String(public_key.to_string());
        }
        value.to_string()
    }

    #[test]
    fn test_generate_keypair() {
        let keypair = KeyManager::generate_keypair();
        assert_eq!(keypair.to_bytes().len(), 64);
    }

    #[test]
    fn test_encrypt_decrypt_with_password() {
        let keypair = KeyManager::generate_keypair();
        let private_key = keypair.to_base58_string();
        let password = "test_password_123";

        let encrypted = KeyManager::encrypt_with_password(&private_key, password).unwrap();
        assert_eq!(
            KeyManager::keystore_version(&encrypted).unwrap(),
            KeystoreVersion::V2
        );
        let decrypted = KeyManager::decrypt_with_password(&encrypted, password).unwrap();

        assert_eq!(private_key, decrypted);
    }

    #[test]
    fn test_get_public_key() {
        let keypair = KeyManager::generate_keypair();
        let private_key = keypair.to_base58_string();
        let expected_pubkey = keypair.pubkey().to_string();

        let pubkey = KeyManager::get_public_key(&private_key).unwrap();
        assert_eq!(pubkey, expected_pubkey);

        for invalid in ["", "not base58", "11111111111111111111111111111111"] {
            let result = std::panic::catch_unwind(|| KeyManager::get_public_key(invalid));
            assert!(result.is_ok());
            assert!(result.unwrap().is_err());
        }
    }

    #[test]
    fn test_keystore_json_round_trip() {
        let keypair = KeyManager::generate_keypair();
        let password = "secure_password";

        let json = KeyManager::keypair_to_encrypted_json(&keypair, password).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["version"], KEYSTORE_V2_VERSION);
        assert_eq!(value["crypto"]["kdf"], KEYSTORE_V2_KDF);
        assert_eq!(value["crypto"]["cipher"], KEYSTORE_V2_CIPHER);
        assert!(value.get("encrypted_private_key").is_none());
        let restored_keypair = KeyManager::keypair_from_encrypted_json_v2(&json, password).unwrap();

        assert_eq!(keypair.to_bytes(), restored_keypair.to_bytes());
    }

    #[test]
    fn test_wrong_password_fails() {
        let keypair = KeyManager::generate_keypair();
        let private_key = keypair.to_base58_string();

        let encrypted =
            KeyManager::encrypt_with_password(&private_key, "correct-password").unwrap();
        let result = KeyManager::decrypt_with_password(&encrypted, "wrong-password");

        assert!(result.is_err());
    }

    #[test]
    fn v2_uses_fresh_salt_and_nonce() {
        let keypair = KeyManager::generate_keypair();
        let first: serde_json::Value = serde_json::from_str(
            &KeyManager::keypair_to_encrypted_json(&keypair, "secure_password").unwrap(),
        )
        .unwrap();
        let second: serde_json::Value = serde_json::from_str(
            &KeyManager::keypair_to_encrypted_json(&keypair, "secure_password").unwrap(),
        )
        .unwrap();

        assert_ne!(
            first["crypto"]["kdf_params"]["salt"],
            second["crypto"]["kdf_params"]["salt"]
        );
        assert_ne!(first["crypto"]["nonce"], second["crypto"]["nonce"]);
        assert_ne!(
            first["crypto"]["ciphertext"],
            second["crypto"]["ciphertext"]
        );
    }

    #[test]
    fn v2_rejects_tampered_ciphertext_and_public_key() {
        let keypair = KeyManager::generate_keypair();
        let password = "secure_password";
        let json = KeyManager::keypair_to_encrypted_json(&keypair, password).unwrap();
        let mut tampered_ciphertext: serde_json::Value = serde_json::from_str(&json).unwrap();
        let mut ciphertext = general_purpose::STANDARD
            .decode(
                tampered_ciphertext["crypto"]["ciphertext"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        ciphertext[0] ^= 1;
        tampered_ciphertext["crypto"]["ciphertext"] =
            serde_json::Value::String(general_purpose::STANDARD.encode(ciphertext));
        assert!(KeyManager::keypair_from_encrypted_json_v2(
            &tampered_ciphertext.to_string(),
            password
        )
        .is_err());

        let mut tampered_public_key: serde_json::Value = serde_json::from_str(&json).unwrap();
        tampered_public_key["public_key"] =
            serde_json::Value::String(Keypair::new().pubkey().to_string());
        assert!(KeyManager::keypair_from_encrypted_json_v2(
            &tampered_public_key.to_string(),
            password
        )
        .is_err());
    }

    #[test]
    fn v2_rejects_unbounded_or_unknown_kdf_parameters_before_derivation() {
        let keypair = KeyManager::generate_keypair();
        let password = "secure_password";
        let json = KeyManager::keypair_to_encrypted_json(&keypair, password).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value["crypto"]["kdf_params"]["memory_kib"] = json!(u32::MAX);

        assert!(KeyManager::keypair_from_encrypted_json_v2(&value.to_string(), password).is_err());
    }

    #[test]
    fn legacy_keystore_is_read_only_and_migrates_explicitly() {
        let keypair = KeyManager::generate_keypair();
        let legacy_password = "old";
        let legacy = legacy_keystore_json(
            &keypair,
            legacy_password,
            Some(&keypair.pubkey().to_string()),
        );
        assert_eq!(
            KeyManager::keystore_version(&legacy).unwrap(),
            KeystoreVersion::LegacyV1
        );
        assert_eq!(
            KeyManager::keypair_from_encrypted_json(&legacy, legacy_password)
                .unwrap()
                .pubkey(),
            keypair.pubkey()
        );
        assert!(KeyManager::keypair_from_encrypted_json_v2(&legacy, legacy_password).is_err());

        let (migrated, verified_public_key) =
            KeyManager::migrate_encrypted_json_to_v2_with_public_key(
                &legacy,
                legacy_password,
                "new-secure-password",
            )
            .unwrap();
        assert_eq!(verified_public_key, keypair.pubkey().to_string());
        assert_eq!(
            KeyManager::keystore_version(&migrated).unwrap(),
            KeystoreVersion::V2
        );
        assert_eq!(
            KeyManager::keypair_from_encrypted_json_v2(&migrated, "new-secure-password")
                .unwrap()
                .pubkey(),
            keypair.pubkey()
        );
    }

    #[test]
    fn migration_rejects_missing_or_mismatched_public_key() {
        let keypair = KeyManager::generate_keypair();
        let password = "legacy-password";
        let missing = legacy_keystore_json(&keypair, password, None);
        assert!(KeyManager::migrate_encrypted_json_to_v2(
            &missing,
            password,
            "new-secure-password"
        )
        .is_err());

        let mismatch = legacy_keystore_json(
            &keypair,
            password,
            Some(&Keypair::new().pubkey().to_string()),
        );
        assert!(KeyManager::migrate_encrypted_json_to_v2(
            &mismatch,
            password,
            "new-secure-password"
        )
        .is_err());
    }

    #[test]
    fn v2_creation_enforces_password_bounds() {
        let keypair = KeyManager::generate_keypair();
        assert!(KeyManager::keypair_to_encrypted_json(&keypair, "123456789").is_err());
        assert!(KeyManager::keypair_to_encrypted_json(
            &keypair,
            &"x".repeat(MAX_PASSWORD_LENGTH + 1)
        )
        .is_err());
    }

    #[test]
    fn version_detection_rejects_unknown_or_malformed_formats() {
        assert!(KeyManager::keystore_version("not-json").is_err());
        assert!(KeyManager::keystore_version(r#"{"version":3}"#).is_err());
        assert!(KeyManager::keystore_version(r#"{"version":2}"#).is_err());
        assert!(KeyManager::keystore_version("{}").is_err());
    }
}
