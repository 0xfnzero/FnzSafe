# Desktop wallet library

The first wallet sets the local wallet password. After password or macOS Touch ID
unlock, **Create wallet** requires only a name. Each wallet still has its own
mnemonic and derived accounts. Creating a wallet no longer returns its mnemonic
to the renderer. Use the existing authenticated export flow for backup.

A process-only AES-GCM credential authorizes creation with the library password.
It is never persisted or returned to JavaScript. It shares the wallet idle policy
and absolute session limit. Locking, deletion, password changes, and migration
invalidate it. Creation checks the authorization generation again before writing
its encrypted record, so a lock during key derivation cancels the write. Export
endpoints do not accept this creation authorization.

## Existing wallets

Existing database records, addresses, derivation paths, and backup formats remain
compatible. Unlock tries the supplied password against all records and unlocks
matching wallets. Wallets using another password remain locked, rather than
preventing access to the matching group. Select a locked wallet and use its old
password to continue using it.

To consolidate an old wallet, first unlock with the desired library password.
In that wallet's actions menu, select **Use unified wallet password**, then enter
its old password. The backend verifies and re-encrypts the complete saved wallet,
checks identities, and replaces the record atomically with a compare-and-swap.
An error leaves the original record unchanged. After success, unlock again with
the library password. Existing exported backups retain their original passwords.
No recovery phrase or address is replaced, and no migration is forced.

## Touch ID and exports

Existing Touch ID enrollment remains usable. An enrolled wallet can unlock all
wallets sharing its password; adding another wallet does not require enrollment
again. An export can use the password or fresh native Touch ID verification.
A Touch ID batch is limited to four explicit export operations and cannot call
arbitrary API routes. Its password stays in native memory; only the selected
export results return to the main wallet UI. Lock epochs cancel pending exports.
DApp webviews do not receive the biometric export capability.

Touch ID requires macOS with enrolled biometrics. Password unlock and export
remain available on other platforms and when biometric authentication fails.

## Regression validation

The ignored API integration test requires an isolated **empty** database path
containing `fnzsafe-library-test`; never point it at a user's wallet database:

```sh
FNZERO_SAFE_DB_PATH="$(mktemp -d /tmp/fnzsafe-library-test.XXXXXX)/wallets.sqlite3" \
  cargo test -p fnzero-safe-desktop-api \
  library_creation_preserves_old_wallets_and_requires_export_authentication \
  -- --ignored --test-threads=1
```

It covers setup, subsequent password-free creation, independent addresses,
unchanged existing ciphertext, export reauthentication, lock rejection, legacy
password groups, atomic adoption, and the continued readability of old backups.
Session unit tests cover expiry, lock generations, and ciphertext integrity.
Native tests restrict biometric exports to the intended operations and reject
password injection. Real Touch ID approval must be completed by the user.
