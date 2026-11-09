//! Process-only authorization for adding wallets after a unified unlock.
//! This credential never reaches JS or disk and is never accepted by export routes.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const AAD: &[u8] = b"fnzsafe-library-creation-v1";
const LOCKED: &str = "Wallet library is locked; unlock with your password or Touch ID first";
struct Credential {
    key: Zeroizing<[u8; 32]>,
    nonce: [u8; 12],
    ciphertext: Zeroizing<Vec<u8>>,
    idle_deadline: Instant,
    absolute_deadline: Instant,
}
#[derive(Default)]
struct State {
    generation: u64,
    credential: Option<Credential>,
}
#[derive(Default)]
pub struct LibrarySession {
    state: Mutex<State>,
}
impl LibrarySession {
    pub fn generation(&self) -> Result<u64, String> {
        let mut state = self.state.lock().map_err(|_| LOCKED)?;
        Self::expire(&mut state);
        Ok(state.generation)
    }
    pub fn invalidate(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| LOCKED)?;
        state.generation = state.generation.wrapping_add(1);
        state.credential = None;
        Ok(())
    }
    pub fn establish(
        &self,
        password: &str,
        generation: u64,
        idle: Duration,
        max: Duration,
    ) -> Result<(), String> {
        if password.is_empty() || password.len() > 1024 || idle.is_zero() || max < idle {
            return Err(LOCKED.into());
        }
        let mut state = self.state.lock().map_err(|_| LOCKED)?;
        if state.generation != generation {
            return Err(LOCKED.into());
        }
        let mut key = Zeroizing::new([0; 32]);
        let mut nonce = [0; 12];
        OsRng.fill_bytes(key.as_mut());
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| LOCKED)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: password.as_bytes(),
                    aad: AAD,
                },
            )
            .map_err(|_| LOCKED)?;
        let now = Instant::now();
        state.generation = state.generation.wrapping_add(1);
        state.credential = Some(Credential {
            key,
            nonce,
            ciphertext: Zeroizing::new(ciphertext),
            idle_deadline: now + idle,
            absolute_deadline: now + max,
        });
        Ok(())
    }
    fn expire(state: &mut State) {
        if state
            .credential
            .as_ref()
            .is_some_and(|c| Instant::now() >= c.idle_deadline.min(c.absolute_deadline))
        {
            state.credential = None;
            state.generation = state.generation.wrapping_add(1);
        }
    }
    pub fn credential(&self) -> Result<(Zeroizing<String>, u64), String> {
        let mut state = self.state.lock().map_err(|_| LOCKED)?;
        Self::expire(&mut state);
        let c = state.credential.as_ref().ok_or(LOCKED)?;
        let cipher = Aes256Gcm::new_from_slice(c.key.as_ref()).map_err(|_| LOCKED)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&c.nonce),
                    Payload {
                        msg: c.ciphertext.as_ref(),
                        aad: AAD,
                    },
                )
                .map_err(|_| LOCKED)?,
        );
        let password = std::str::from_utf8(&plaintext).map_err(|_| LOCKED)?;
        Ok((Zeroizing::new(password.to_string()), state.generation))
    }
    pub fn purge_expired(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| LOCKED)?;
        Self::expire(&mut state);
        Ok(())
    }
    pub fn touch(&self, idle: Duration) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| LOCKED)?;
        Self::expire(&mut state);
        if let Some(c) = state.credential.as_mut() {
            c.idle_deadline = (Instant::now() + idle).min(c.absolute_deadline);
        }
        Ok(())
    }
    /// The short database commit is serialized with locking. Expensive key derivation
    /// happens before this call; a lock during that work cancels the write.
    pub fn commit<T>(
        &self,
        generation: u64,
        needs_session: bool,
        action: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|_| LOCKED)?;
        Self::expire(&mut state);
        if state.generation != generation || (needs_session && state.credential.is_none()) {
            return Err(LOCKED.into());
        }
        Ok(action())
    }
}
pub fn library_session() -> &'static LibrarySession {
    static SESSION: OnceLock<LibrarySession> = OnceLock::new();
    SESSION.get_or_init(LibrarySession::default)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locked_expired_and_cancelled_creation_cannot_commit() {
        let s = LibrarySession::default();
        assert!(s.credential().is_err());
        s.establish(
            "password-test",
            s.generation().unwrap(),
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .unwrap();
        let (password, epoch) = s.credential().unwrap();
        assert_eq!(password.as_str(), "password-test");
        assert_eq!(s.commit(epoch, true, || 42).unwrap(), 42);
        s.invalidate().unwrap();
        assert!(s.credential().is_err());
        assert!(s.commit(epoch, true, || panic!("stale write")).is_err());
        assert!(s
            .establish(
                "password-test",
                epoch,
                Duration::from_secs(30),
                Duration::from_secs(60)
            )
            .is_err());
        let epoch = s.generation().unwrap();
        s.establish(
            "password-test",
            epoch,
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .unwrap();
        let epoch = s.generation().unwrap();
        s.state
            .lock()
            .unwrap()
            .credential
            .as_mut()
            .unwrap()
            .idle_deadline = Instant::now();
        s.touch(Duration::from_secs(30)).unwrap();
        assert!(s.credential().is_err());
        assert!(s.commit(epoch, true, || panic!("expired write")).is_err());
    }
    #[test]
    fn fresh_unlock_cancels_previous_creation_lease_and_expired_unlock_can_restart() {
        let s = LibrarySession::default();
        s.establish(
            "first-password",
            s.generation().unwrap(),
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .unwrap();
        let (_, old_epoch) = s.credential().unwrap();
        s.establish(
            "second-password",
            old_epoch,
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .unwrap();
        assert!(s
            .commit(old_epoch, true, || panic!("old authorization"))
            .is_err());
        s.state
            .lock()
            .unwrap()
            .credential
            .as_mut()
            .unwrap()
            .idle_deadline = Instant::now();
        let fresh_epoch = s.generation().unwrap();
        s.establish(
            "second-password",
            fresh_epoch,
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(s.credential().unwrap().0.as_str(), "second-password");
    }

    #[test]
    fn encryption_integrity_and_absolute_timeout_are_enforced() {
        let s = LibrarySession::default();
        s.establish(
            "password-test",
            s.generation().unwrap(),
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .unwrap();
        s.state
            .lock()
            .unwrap()
            .credential
            .as_mut()
            .unwrap()
            .ciphertext[0] ^= 1;
        assert!(s.credential().is_err());
        s.establish(
            "password-test",
            s.generation().unwrap(),
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .unwrap();
        s.state
            .lock()
            .unwrap()
            .credential
            .as_mut()
            .unwrap()
            .absolute_deadline = Instant::now();
        s.touch(Duration::from_secs(600)).unwrap();
        assert!(s.credential().is_err());
    }
}
