use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

const SESSION_KEY_BYTES: usize = 32;
const SESSION_NONCE_BYTES: usize = 12;
const SOLANA_KEYPAIR_BYTES: usize = 64;
const EVM_PRIVATE_KEY_BYTES: usize = 32;
const MAX_MNEMONIC_BYTES: usize = 1_024;
const SESSION_PAYLOAD_MAGIC: &[u8; 4] = b"FZWS";
const SESSION_PAYLOAD_VERSION: u8 = 2;
const SESSION_PAYLOAD_EVM_FLAG: u8 = 1;
const SESSION_PAYLOAD_MNEMONIC_FLAG: u8 = 2;

pub struct WalletSessionSecrets {
    solana_keypair: Zeroizing<[u8; SOLANA_KEYPAIR_BYTES]>,
    evm_private_key: Option<Zeroizing<[u8; EVM_PRIVATE_KEY_BYTES]>>,
    mnemonic: Option<Zeroizing<String>>,
}

impl WalletSessionSecrets {
    pub fn new(
        solana_keypair: &[u8],
        evm_private_key: Option<&[u8]>,
        mnemonic: Option<&str>,
    ) -> Result<Self, String> {
        let solana_keypair = solana_keypair
            .try_into()
            .map_err(|_| "Solana session keypair must be 64 bytes".to_string())?;
        let evm_private_key = evm_private_key
            .map(|bytes| {
                bytes
                    .try_into()
                    .map(Zeroizing::new)
                    .map_err(|_| "EVM session private key must be 32 bytes".to_string())
            })
            .transpose()?;
        let mnemonic = mnemonic
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                if value.len() > MAX_MNEMONIC_BYTES {
                    Err("wallet session mnemonic is too large".to_string())
                } else {
                    Ok(Zeroizing::new(value.to_string()))
                }
            })
            .transpose()?;
        Ok(Self {
            solana_keypair: Zeroizing::new(solana_keypair),
            evm_private_key,
            mnemonic,
        })
    }

    pub fn solana_keypair(&self) -> &[u8] {
        self.solana_keypair.as_ref()
    }

    pub fn evm_private_key(&self) -> Option<&[u8]> {
        self.evm_private_key
            .as_deref()
            .map(|bytes| bytes.as_slice())
    }

    pub fn mnemonic(&self) -> Option<&str> {
        self.mnemonic.as_deref().map(String::as_str)
    }

    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let mnemonic_len = self.mnemonic.as_ref().map_or(0, |value| value.len());
        let mut encoded = Zeroizing::new(Vec::with_capacity(
            8 + SOLANA_KEYPAIR_BYTES
                + self
                    .evm_private_key
                    .as_ref()
                    .map_or(0, |_| EVM_PRIVATE_KEY_BYTES)
                + mnemonic_len,
        ));
        encoded.extend_from_slice(SESSION_PAYLOAD_MAGIC);
        encoded.push(SESSION_PAYLOAD_VERSION);
        let flags = u8::from(self.evm_private_key.is_some()) * SESSION_PAYLOAD_EVM_FLAG
            | u8::from(self.mnemonic.is_some()) * SESSION_PAYLOAD_MNEMONIC_FLAG;
        encoded.push(flags);
        encoded.extend_from_slice(self.solana_keypair.as_ref());
        if let Some(private_key) = self.evm_private_key.as_ref() {
            encoded.extend_from_slice(private_key.as_ref());
        }
        if let Some(mnemonic) = self.mnemonic.as_ref() {
            encoded.extend_from_slice(&(mnemonic.len() as u16).to_be_bytes());
            encoded.extend_from_slice(mnemonic.as_bytes());
        }
        encoded
    }

    fn decode(encoded: &[u8]) -> Result<Self, String> {
        let header_len = SESSION_PAYLOAD_MAGIC.len() + 2;
        if encoded.len() < header_len + SOLANA_KEYPAIR_BYTES
            || &encoded[..SESSION_PAYLOAD_MAGIC.len()] != SESSION_PAYLOAD_MAGIC
            || encoded[SESSION_PAYLOAD_MAGIC.len()] != SESSION_PAYLOAD_VERSION
        {
            return Err("wallet session payload is invalid or unsupported".to_string());
        }
        let flags = encoded[SESSION_PAYLOAD_MAGIC.len() + 1];
        let supported_flags = SESSION_PAYLOAD_EVM_FLAG | SESSION_PAYLOAD_MNEMONIC_FLAG;
        if flags & !supported_flags != 0 {
            return Err("wallet session payload flags are unsupported".to_string());
        }
        let solana_end = header_len + SOLANA_KEYPAIR_BYTES;
        let evm_end = solana_end
            + if flags & SESSION_PAYLOAD_EVM_FLAG != 0 {
                EVM_PRIVATE_KEY_BYTES
            } else {
                0
            };
        if encoded.len() < evm_end {
            return Err("wallet session payload length is invalid".to_string());
        }
        let mnemonic = if flags & SESSION_PAYLOAD_MNEMONIC_FLAG != 0 {
            let length_end = evm_end.saturating_add(2);
            if encoded.len() < length_end {
                return Err("wallet session mnemonic length is invalid".to_string());
            }
            let mnemonic_len =
                u16::from_be_bytes([encoded[evm_end], encoded[evm_end + 1]]) as usize;
            if mnemonic_len == 0
                || mnemonic_len > MAX_MNEMONIC_BYTES
                || encoded.len() != length_end.saturating_add(mnemonic_len)
            {
                return Err("wallet session mnemonic length is invalid".to_string());
            }
            Some(
                std::str::from_utf8(&encoded[length_end..])
                    .map_err(|_| "wallet session mnemonic encoding is invalid".to_string())?,
            )
        } else {
            if encoded.len() != evm_end {
                return Err("wallet session payload length is invalid".to_string());
            }
            None
        };
        Self::new(
            &encoded[header_len..solana_end],
            (flags & SESSION_PAYLOAD_EVM_FLAG != 0).then_some(&encoded[solana_end..evm_end]),
            mnemonic,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletSessionStatus {
    pub wallet_id: String,
    pub identity: String,
    pub expires_in_seconds: u64,
}

struct WalletSession {
    identity: String,
    wrapping_key: Zeroizing<[u8; SESSION_KEY_BYTES]>,
    nonce: [u8; SESSION_NONCE_BYTES],
    ciphertext: Zeroizing<Vec<u8>>,
    created_at: Instant,
    last_used_at: Instant,
    idle_ttl: Duration,
    max_lifetime: Duration,
}

impl WalletSession {
    fn expires_at(&self) -> Instant {
        self.created_at
            .checked_add(self.max_lifetime)
            .unwrap_or(self.created_at)
            .min(
                self.last_used_at
                    .checked_add(self.idle_ttl)
                    .unwrap_or(self.last_used_at),
            )
    }

    fn expired(&self, now: Instant) -> bool {
        now >= self.expires_at()
    }
}

impl Drop for WalletSession {
    fn drop(&mut self) {
        self.nonce.zeroize();
    }
}

/// Keeps wallet material encrypted while the desktop API process is alive.
///
/// This reduces long-lived plaintext exposure, but cannot defend against an
/// attacker that can read the entire process memory because the wrapping key
/// and ciphertext necessarily live in the same process.
pub struct WalletSessionVault {
    sessions: Mutex<HashMap<String, WalletSession>>,
}

impl Default for WalletSessionVault {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl WalletSessionVault {
    pub fn unlock(
        &self,
        wallet_id: &str,
        identity: &str,
        secrets: &WalletSessionSecrets,
        idle_ttl: Duration,
        max_lifetime: Duration,
    ) -> Result<(), String> {
        if wallet_id.is_empty() || identity.is_empty() {
            return Err("wallet session input is incomplete".to_string());
        }
        if idle_ttl.is_zero() || max_lifetime < idle_ttl {
            return Err("wallet session lifetime is invalid".to_string());
        }

        let mut wrapping_key = Zeroizing::new([0_u8; SESSION_KEY_BYTES]);
        let mut nonce = [0_u8; SESSION_NONCE_BYTES];
        OsRng.fill_bytes(wrapping_key.as_mut());
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(wrapping_key.as_ref())
            .map_err(|_| "failed to initialize wallet session cipher".to_string())?;
        let aad = session_aad(wallet_id, identity);
        let plaintext = secrets.encode();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_ref(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| "failed to encrypt wallet session".to_string())?;
        let now = Instant::now();
        let session = WalletSession {
            identity: identity.to_string(),
            wrapping_key,
            nonce,
            ciphertext: Zeroizing::new(ciphertext),
            created_at: now,
            last_used_at: now,
            idle_ttl,
            max_lifetime,
        };
        self.sessions
            .lock()
            .map_err(|_| "wallet session vault lock is poisoned".to_string())?
            .insert(wallet_id.to_string(), session);
        Ok(())
    }

    pub fn decrypt(
        &self,
        wallet_id: &str,
        expected_identity: &str,
    ) -> Result<WalletSessionSecrets, String> {
        let now = Instant::now();
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "wallet session vault lock is poisoned".to_string())?;
        if sessions
            .get(wallet_id)
            .is_some_and(|session| session.expired(now))
        {
            sessions.remove(wallet_id);
            return Err("wallet session expired; unlock the wallet again".to_string());
        }
        let session = sessions
            .get_mut(wallet_id)
            .ok_or_else(|| "wallet is locked; unlock it before signing".to_string())?;
        if session.identity != expected_identity {
            sessions.remove(wallet_id);
            return Err("wallet session identity does not match the saved wallet".to_string());
        }
        let cipher = Aes256Gcm::new_from_slice(session.wrapping_key.as_ref())
            .map_err(|_| "failed to initialize wallet session cipher".to_string())?;
        let aad = session_aad(wallet_id, expected_identity);
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&session.nonce),
                Payload {
                    msg: session.ciphertext.as_ref(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| "wallet session integrity check failed".to_string())?;
        session.last_used_at = now;
        let plaintext = Zeroizing::new(plaintext);
        let decoded = WalletSessionSecrets::decode(plaintext.as_ref());
        if decoded.is_err() {
            sessions.remove(wallet_id);
        }
        decoded
    }

    pub fn status(&self, wallet_id: &str) -> Result<Option<WalletSessionStatus>, String> {
        let now = Instant::now();
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "wallet session vault lock is poisoned".to_string())?;
        if sessions
            .get(wallet_id)
            .is_some_and(|session| session.expired(now))
        {
            sessions.remove(wallet_id);
            return Ok(None);
        }
        Ok(sessions.get(wallet_id).map(|session| WalletSessionStatus {
            wallet_id: wallet_id.to_string(),
            identity: session.identity.clone(),
            expires_in_seconds: session
                .expires_at()
                .saturating_duration_since(now)
                .as_secs(),
        }))
    }

    pub fn lock(&self, wallet_id: &str) -> Result<bool, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "wallet session vault lock is poisoned".to_string())?
            .remove(wallet_id)
            .is_some())
    }

    pub fn lock_all(&self) -> Result<usize, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "wallet session vault lock is poisoned".to_string())?;
        let count = sessions.len();
        sessions.clear();
        Ok(count)
    }

    pub fn purge_expired(&self) -> Result<usize, String> {
        let now = Instant::now();
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "wallet session vault lock is poisoned".to_string())?;
        let before = sessions.len();
        sessions.retain(|_, session| !session.expired(now));
        Ok(before.saturating_sub(sessions.len()))
    }
}

fn session_aad(wallet_id: &str, identity: &str) -> String {
    format!("fnzsafe-wallet-session-v1\0{wallet_id}\0{identity}")
}

static WALLET_SESSION_VAULT: OnceLock<WalletSessionVault> = OnceLock::new();

pub fn wallet_session_vault() -> &'static WalletSessionVault {
    WALLET_SESSION_VAULT.get_or_init(WalletSessionVault::default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    const IDLE: Duration = Duration::from_secs(30);
    const MAX: Duration = Duration::from_secs(60);

    fn secrets(seed: u8, with_evm: bool) -> WalletSessionSecrets {
        let solana = [seed; SOLANA_KEYPAIR_BYTES];
        let evm = [seed.wrapping_add(1); EVM_PRIVATE_KEY_BYTES];
        WalletSessionSecrets::new(
            &solana,
            with_evm.then_some(evm.as_slice()),
            with_evm.then_some("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
        )
        .unwrap()
    }

    #[test]
    fn sessions_round_trip_and_are_scoped_to_wallet_identity() {
        let vault = WalletSessionVault::default();
        let first = secrets(1, true);
        let second = secrets(2, false);
        vault
            .unlock("wallet-a", "pubkey-a", &first, IDLE, MAX)
            .unwrap();
        vault
            .unlock("wallet-b", "pubkey-b", &second, IDLE, MAX)
            .unwrap();

        let first_decrypted = vault.decrypt("wallet-a", "pubkey-a").unwrap();
        assert_eq!(first_decrypted.solana_keypair(), &[1; SOLANA_KEYPAIR_BYTES]);
        assert_eq!(
            first_decrypted.evm_private_key(),
            Some([2; EVM_PRIVATE_KEY_BYTES].as_slice())
        );
        assert!(first_decrypted.mnemonic().is_some());
        let second_decrypted = vault.decrypt("wallet-b", "pubkey-b").unwrap();
        assert_eq!(
            second_decrypted.solana_keypair(),
            &[2; SOLANA_KEYPAIR_BYTES]
        );
        assert_eq!(second_decrypted.evm_private_key(), None);
        assert_eq!(second_decrypted.mnemonic(), None);
        assert!(vault.decrypt("wallet-a", "pubkey-b").is_err());
        assert!(vault.decrypt("wallet-a", "pubkey-a").is_err());
    }

    #[test]
    fn repeated_unlock_uses_fresh_key_and_nonce() {
        let vault = WalletSessionVault::default();
        let secrets = secrets(3, true);
        vault
            .unlock("wallet", "pubkey", &secrets, IDLE, MAX)
            .unwrap();
        let first = {
            let sessions = vault.sessions.lock().unwrap();
            let session = sessions.get("wallet").unwrap();
            (
                session.wrapping_key.to_vec(),
                session.nonce,
                session.ciphertext.to_vec(),
            )
        };
        vault
            .unlock("wallet", "pubkey", &secrets, IDLE, MAX)
            .unwrap();
        let second = {
            let sessions = vault.sessions.lock().unwrap();
            let session = sessions.get("wallet").unwrap();
            (
                session.wrapping_key.to_vec(),
                session.nonce,
                session.ciphertext.to_vec(),
            )
        };

        assert_ne!(first.0, second.0);
        assert_ne!(first.1, second.1);
        assert_ne!(first.2, second.2);
    }

    #[test]
    fn expired_session_is_destroyed() {
        let vault = WalletSessionVault::default();
        let secrets = secrets(4, false);
        vault
            .unlock(
                "wallet",
                "pubkey",
                &secrets,
                Duration::from_millis(1),
                Duration::from_millis(2),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(4));

        assert!(vault.decrypt("wallet", "pubkey").is_err());
        assert_eq!(vault.status("wallet").unwrap(), None);
    }

    #[test]
    fn lock_and_lock_all_remove_sessions() {
        let vault = WalletSessionVault::default();
        let first = secrets(5, false);
        let second = secrets(6, true);
        vault
            .unlock("wallet-a", "pubkey-a", &first, IDLE, MAX)
            .unwrap();
        vault
            .unlock("wallet-b", "pubkey-b", &second, IDLE, MAX)
            .unwrap();
        assert!(vault.lock("wallet-a").unwrap());
        assert!(vault.decrypt("wallet-a", "pubkey-a").is_err());
        assert_eq!(vault.lock_all().unwrap(), 1);
        assert!(vault.decrypt("wallet-b", "pubkey-b").is_err());
    }

    #[test]
    fn purge_expired_removes_all_stale_sessions_without_accessing_them() {
        let vault = WalletSessionVault::default();
        let first = secrets(8, false);
        let second = secrets(9, true);
        for (wallet_id, identity, secrets) in [
            ("wallet-a", "pubkey-a", first),
            ("wallet-b", "pubkey-b", second),
        ] {
            vault
                .unlock(
                    wallet_id,
                    identity,
                    &secrets,
                    Duration::from_millis(1),
                    Duration::from_millis(2),
                )
                .unwrap();
        }
        thread::sleep(Duration::from_millis(4));
        assert_eq!(vault.purge_expired().unwrap(), 2);
        assert!(vault.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn session_payload_rejects_unknown_versions_and_lengths() {
        let encoded = secrets(7, true).encode();
        let mut wrong_version = encoded.to_vec();
        wrong_version[SESSION_PAYLOAD_MAGIC.len()] = SESSION_PAYLOAD_VERSION + 1;
        assert!(WalletSessionSecrets::decode(&wrong_version).is_err());
        assert!(WalletSessionSecrets::decode(&encoded[..encoded.len() - 1]).is_err());
    }
}
