import { argon2idAsync } from '@noble/hashes/argon2';
import { HDNodeWallet, Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import bs58 from 'bs58';
import { createInitialVault, createPrivateKeyVault, decryptVault, deriveEd25519Path } from './vault';
import type { ChainFamily, VaultPayload } from './types';

export type WalletImport = { kind: 'mnemonic' | 'privateKey' | 'encrypted'; text: string; family: ChainFamily; password?: string; bitcoinAddressType?: 'native-segwit' | 'taproot' };
function base64(raw: unknown, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof raw !== 'string' || raw.length > 32_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw new Error('Invalid encrypted backup');
  const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) throw new Error('Invalid encrypted backup');
  return bytes;
}
export async function importWallet(input: WalletImport, depth = 0): Promise<VaultPayload> {
  if (depth > 1) throw new Error('Nested backup limit exceeded');
  if (!input || typeof input.text !== 'string' || input.text.length > 700_000) throw new Error('Wallet import exceeds the size limit');
  if (input.kind === 'mnemonic') {
    if (!input.text.trim()) throw new Error('Enter a recovery phrase');
    return createInitialVault(input.text);
  }
  if (input.kind === 'privateKey') return createPrivateKeyVault(input.family, input.text, input.bitcoinAddressType);
  if (input.kind !== 'encrypted') throw new Error('Unknown import format');
  const password = input.password ?? '';
  if (!password || password.length > 1024) throw new Error('Enter the backup password');
  const doc = JSON.parse(input.text);
  if (doc?.kdf?.name === 'PBKDF2') return decryptVault(doc, password);
  // Standard Web3 keystore v3. Bound the work factor before handing it to ethers.
  if (doc?.version === 3 && (doc.crypto ?? doc.Crypto)?.cipher === 'aes-128-ctr') {
    const params = (doc.crypto ?? doc.Crypto).kdfparams;
    const kdf = (doc.crypto ?? doc.Crypto).kdf;
    if (params?.dklen !== 32 || (kdf === 'scrypt'
      ? !Number.isInteger(params.n) || params.n < 2 || params.n > 262144 || (params.n & (params.n - 1)) !== 0 || params.r !== 8 || params.p !== 1
      : kdf !== 'pbkdf2' || params.prf !== 'hmac-sha256' || !Number.isInteger(params.c) || params.c < 1 || params.c > 1_200_000)) throw new Error('Unsupported keystore work factor');
    const wallet = await Wallet.fromEncryptedJson(input.text, password);
    return createPrivateKeyVault('evm', wallet.privateKey);
  }
  const c = doc?.crypto;
  if (c?.kdf !== 'argon2id' || c.cipher !== 'aes-256-gcm' || c.kdf_params?.memory_kib !== 65536 || c.kdf_params.iterations !== 3 || c.kdf_params.parallelism !== 1) throw new Error('Unsupported encrypted backup format');
  const evm = doc.wallet_family === 'evm';
  const envelope = doc.version === 1 && doc.kind === 'password-secret';
  let aad: string;
  if (envelope) aad = 'fnzsafe-secret-envelope-v1';
  else if (evm && doc.version === 1 && (!doc.secret_type || doc.secret_type === 'private_key')) aad = `fnzero-safe-evm-keystore\0${doc.address}`;
  else if (evm && doc.version === 2 && ['private_key', 'mnemonic'].includes(doc.secret_type)) aad = `fnzero-safe-evm-keystore\0\x02\0evm\0${doc.address}\0${doc.secret_type}\0${doc.derivation_path ?? ''}`;
  else if (!evm && doc.encryption_type === 'password_only' && doc.version === 2) aad = `sol-safekey-keystore\0\x02\0${doc.public_key}`;
  else if (!evm && doc.encryption_type === 'password_only' && doc.version === 3 && doc.secret_type === 'mnemonic') aad = `sol-safekey-keystore\0\x03\0${doc.public_key}\0mnemonic\0${doc.derivation_path}`;
  else throw new Error('Unsupported desktop backup version');
  const salt = base64(c.kdf_params.salt, 16), iv = base64(c.nonce, 12), encrypted = base64(c.ciphertext);
  if (encrypted.length < 17 || encrypted.length > 16_400) throw new Error('Invalid encrypted backup');
  const keyBytes = await argon2idAsync(password, salt, { m: 65536, t: 3, p: 1, dkLen: 32, asyncTick: 10, maxmem: 70 * 1024 * 1024 });
  let clear: Uint8Array | undefined;
  try {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyBytes), 'AES-GCM', false, ['decrypt']);
    clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, encrypted));
    if (envelope) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(clear);
      if (!text.trim()) throw new Error('Empty encrypted secret');
      try { return createInitialVault(text); } catch { return createPrivateKeyVault(input.family, text, input.bitcoinAddressType); }
    }
    let payload: VaultPayload;
    if (doc.secret_type === 'mnemonic') {
      const phrase = new TextDecoder('utf-8', { fatal: true }).decode(clear);
      payload = createInitialVault(phrase);
      if (typeof doc.derivation_path !== 'string' || doc.derivation_path.length > 128) throw new Error('Invalid derivation path');
      const seed = mnemonicToSeedSync(phrase);
      try {
        if (evm) {
          const wallet = HDNodeWallet.fromSeed(seed).derivePath(doc.derivation_path);
          const index = payload.accounts.findIndex(a => a.family === 'evm');
          payload.accounts[index] = { ...payload.accounts[index], address: wallet.address, privateKey: wallet.privateKey, derivationPath: doc.derivation_path };
        } else {
          const secret = deriveEd25519Path(seed, doc.derivation_path);
          try {
            const pair = Keypair.fromSeed(secret);
            const index = payload.accounts.findIndex(a => a.family === 'solana');
            payload.accounts[index] = { ...payload.accounts[index], address: pair.publicKey.toBase58(), privateKey: bs58.encode(pair.secretKey), derivationPath: doc.derivation_path };
          } finally { secret.fill(0); }
        }
      } finally { seed.fill(0); }
    } else payload = createPrivateKeyVault(evm ? 'evm' : 'solana', evm ? Array.from(clear, b => b.toString(16).padStart(2, '0')).join('') : bs58.encode(clear));
    const address = payload.accounts.find(a => a.family === (evm ? 'evm' : 'solana'))!.address;
    if (evm ? address.toLowerCase() !== String(doc.address).toLowerCase() : address !== doc.public_key) throw new Error('Backup address mismatch');
    if (!evm && typeof doc.metadata?.evm_keystore_json === 'string') {
      const nested = JSON.parse(doc.metadata.evm_keystore_json);
      if (nested.wallet_family !== 'evm') throw new Error('Invalid nested EVM backup');
      const restored = await importWallet({ kind: 'encrypted', text: doc.metadata.evm_keystore_json, family: 'evm', password }, depth + 1);
      const account = restored.accounts.find(a => a.family === 'evm')!;
      const index = payload.accounts.findIndex(a => a.family === 'evm');
      if (index >= 0) payload.accounts[index] = { ...account, id: payload.accounts[index].id };
      else payload.accounts.push(account);
    }
    return payload;
  } catch { throw new Error('Incorrect backup password or damaged backup'); }
  finally { keyBytes.fill(0); clear?.fill(0); }
}
