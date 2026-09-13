import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { HDNodeWallet, SigningKey, computeAddress } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bech32, bech32m } from '@scure/base';
import { HDKey } from '@scure/bip32';
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { EncryptedVault, VaultPayload } from './types';

const KDF_ITERATIONS = 600_000;
const MAX_KDF_ITERATIONS = 1_200_000;
const MAX_VAULT_BYTES = 512 * 1024;
const MAX_ACCOUNTS = 100;
const MAX_PASSWORD_LENGTH = 1024;
const BITCOIN_TAPROOT_PATH = "m/86'/0'/0'/0/0";
const BITCOIN_NATIVE_SEGWIT_PATH = "m/84'/0'/0'/0/0";
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function encode(bytes: ArrayBuffer | Uint8Array): string {
  const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary);
}

function decode(value: string, expectedLength?: number, maxLength = MAX_VAULT_BYTES): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxLength / 3) * 4 + 4) {
    throw new Error('Invalid vault encoding');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid vault encoding');
  }
  const binary = atob(value);
  if (binary.length > maxLength || (expectedLength !== undefined && binary.length !== expectedLength)) {
    throw new Error('Invalid vault encoding');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const passwordBytes = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    passwordBytes.fill(0);
  }
}

export async function encryptVault(payload: VaultPayload, password: string): Promise<EncryptedVault> {
  if (password.length < 10) throw new Error('Use a password with at least 10 characters');
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('Wallet password is too long');
  validateVaultPayload(payload);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const cleartext = encoder.encode(JSON.stringify(payload));
  try {
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, cleartext);
    return {
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: encode(salt) },
      cipher: { name: 'AES-GCM', iv: encode(iv), data: encode(data) },
    };
  } finally {
    cleartext.fill(0);
  }
}

export async function decryptVault(vault: EncryptedVault, password: string): Promise<VaultPayload> {
  return (await decryptVaultWithMigration(vault, password)).payload;
}

export async function decryptVaultWithMigration(
  vault: EncryptedVault,
  password: string,
): Promise<{ payload: VaultPayload; migrated: boolean }> {
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('Incorrect password or damaged wallet vault');
  if (
    !vault || vault.version !== 1 || vault.kdf?.name !== 'PBKDF2' ||
    vault.kdf.hash !== 'SHA-256' || vault.cipher?.name !== 'AES-GCM' ||
    !Number.isSafeInteger(vault.kdf.iterations) || vault.kdf.iterations < KDF_ITERATIONS ||
    vault.kdf.iterations > MAX_KDF_ITERATIONS
  ) throw new Error('Unsupported or weak vault format');
  let salt: Uint8Array<ArrayBuffer>;
  let iv: Uint8Array<ArrayBuffer>;
  let encrypted: Uint8Array<ArrayBuffer>;
  try {
    salt = decode(vault.kdf.salt, 16, 16);
    iv = decode(vault.cipher.iv, 12, 12);
    encrypted = decode(vault.cipher.data);
    if (encrypted.length < 17) throw new Error('Invalid vault ciphertext');
  } catch {
    throw new Error('Incorrect password or damaged wallet vault');
  }
  const key = await deriveKey(password, salt, vault.kdf.iterations);
  let cleartext: Uint8Array | undefined;
  try {
    cleartext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encrypted,
    ));
    const payload = JSON.parse(decoder.decode(cleartext)) as VaultPayload;
    const migrated = migrateLegacyBitcoinAddresses(payload);
    validateVaultPayload(payload);
    return { payload, migrated };
  } catch {
    throw new Error('Incorrect password or damaged wallet vault');
  } finally {
    cleartext?.fill(0);
  }
}

export function createInitialVault(importedMnemonic?: string): VaultPayload {
  const mnemonic =
    importedMnemonic?.trim().toLowerCase() || generateMnemonic(wordlist, 128);
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid BIP-39 recovery phrase');
  }
  const seed = mnemonicToSeedSync(mnemonic);
  let solanaKey: Uint8Array | undefined;
  let bitcoinTaprootKey: Uint8Array | undefined;
  try {
    const evm = HDNodeWallet.fromSeed(seed).derivePath("m/44'/60'/0'/0/0");
    solanaKey = deriveEd25519Path(seed, "m/44'/501'/0'/0'");
    const solana = Keypair.fromSeed(Uint8Array.from(solanaKey));
    const bitcoinNode = HDKey.fromMasterSeed(seed).derive(BITCOIN_TAPROOT_PATH);
    const bitcoinNativeSegwitNode = HDKey.fromMasterSeed(seed).derive(BITCOIN_NATIVE_SEGWIT_PATH);
    const tronNode = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'/0/0");
    if (!bitcoinNode.publicKey || !bitcoinNode.privateKey ||
        !bitcoinNativeSegwitNode.publicKey || !bitcoinNativeSegwitNode.privateKey ||
        !tronNode.privateKey) {
      throw new Error('Unable to derive multichain accounts');
    }
    bitcoinTaprootKey = taprootAccountPrivateKey(bitcoinNode.privateKey);
    const bitcoinAddress = bitcoinAddressFromPublicKey(secp256k1.getPublicKey(bitcoinTaprootKey, true));
    const bitcoinNativeSegwitAddress = nativeSegwitAddressFromPublicKey(bitcoinNativeSegwitNode.publicKey);
    const tronAddress = tronAddressFromPrivateKey(`0x${toHex(tronNode.privateKey)}`);
    const evmId = crypto.randomUUID();
    return {
      recoveryMnemonic: mnemonic,
      accounts: [
        { id: evmId, name: 'EVM Account 1', family: 'evm', address: evm.address, privateKey: evm.privateKey },
        { id: crypto.randomUUID(), name: 'Solana Account 1', family: 'solana', address: solana.publicKey.toBase58(), privateKey: bs58.encode(solana.secretKey) },
        { id: crypto.randomUUID(), name: 'Bitcoin Taproot', family: 'bitcoin', address: bitcoinAddress, privateKey: `0x${toHex(bitcoinTaprootKey)}`, derivationPath: BITCOIN_TAPROOT_PATH },
        { id: crypto.randomUUID(), name: 'Bitcoin Native SegWit', family: 'bitcoin', address: bitcoinNativeSegwitAddress, privateKey: `0x${toHex(bitcoinNativeSegwitNode.privateKey)}`, derivationPath: BITCOIN_NATIVE_SEGWIT_PATH },
        { id: crypto.randomUUID(), name: 'TRON Account 1', family: 'tron', address: tronAddress, privateKey: `0x${toHex(tronNode.privateKey)}` },
      ],
      selectedAccountId: evmId,
      selectedEvmChainId: 1,
      selectedSolanaCluster: 'mainnet-beta',
    };
  } finally {
    seed.fill(0);
    solanaKey?.fill(0);
    bitcoinTaprootKey?.fill(0);
  }
}

function validateVaultPayload(payload: VaultPayload): void {
  if (!payload || typeof payload !== 'object' || typeof payload.recoveryMnemonic !== 'string' ||
      payload.recoveryMnemonic.length > 512 || !validateMnemonic(payload.recoveryMnemonic, wordlist) ||
      !Array.isArray(payload.accounts) || payload.accounts.length === 0 || payload.accounts.length > MAX_ACCOUNTS ||
      typeof payload.selectedAccountId !== 'string' || payload.selectedAccountId.length > 128 ||
      !Number.isSafeInteger(payload.selectedEvmChainId) || payload.selectedEvmChainId <= 0 ||
      !['mainnet-beta', 'devnet'].includes(payload.selectedSolanaCluster)) {
    throw new Error('Invalid vault contents');
  }
  const ids = new Set<string>();
  for (const account of payload.accounts) {
    if (!account || typeof account.id !== 'string' || account.id.length === 0 || account.id.length > 128 ||
        ids.has(account.id) || typeof account.name !== 'string' || account.name.length === 0 || account.name.length > 80 ||
        !['evm', 'solana', 'bitcoin', 'tron'].includes(account.family) ||
        typeof account.address !== 'string' || account.address.length > 128 ||
        typeof account.privateKey !== 'string' || account.privateKey.length > 256 ||
        (account.derivationPath !== undefined &&
          (typeof account.derivationPath !== 'string' || account.derivationPath.length > 128)) ||
        (account.family === 'bitcoin' && account.derivationPath !== BITCOIN_TAPROOT_PATH &&
          account.derivationPath !== BITCOIN_NATIVE_SEGWIT_PATH) ||
        addressFromAccountKey(account.family, account.privateKey, account.derivationPath) !== account.address) {
      throw new Error('Invalid vault contents');
    }
    ids.add(account.id);
  }
  if (!ids.has(payload.selectedAccountId)) throw new Error('Invalid vault contents');
}

function addressFromAccountKey(family: string, privateKey: string, derivationPath?: string): string {
  if (family === 'evm') return computeAddress(privateKey);
  if (family === 'solana') {
    const bytes = bs58.decode(privateKey);
    if (bytes.length !== 64) throw new Error('Invalid Solana private key');
    return Keypair.fromSecretKey(bytes).publicKey.toBase58();
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid private key');
  if (family === 'bitcoin') {
    const publicKey = getBytesFromHex(new SigningKey(privateKey).compressedPublicKey.slice(2));
    return derivationPath === BITCOIN_NATIVE_SEGWIT_PATH
      ? nativeSegwitAddressFromPublicKey(publicKey)
      : bitcoinAddressFromPublicKey(publicKey);
  }
  if (family === 'tron') return tronAddressFromPrivateKey(privateKey);
  throw new Error('Unknown chain family');
}

function bitcoinAddressFromPublicKey(publicKey: Uint8Array): string {
  const internalKey = secp256k1.Point.fromBytes(publicKey);
  const evenInternalKey = internalKey.y & 1n ? internalKey.negate() : internalKey;
  const xOnlyKey = evenInternalKey.toBytes(true).slice(1);
  const tweak = BigInt(`0x${toHex(taggedHash('TapTweak', xOnlyKey))}`);
  if (tweak >= secp256k1.CURVE.n) throw new Error('Invalid Taproot tweak');
  const outputKey = evenInternalKey.add(secp256k1.Point.BASE.multiply(tweak));
  return bech32m.encode('bc', [1, ...bech32m.toWords(outputKey.toBytes(true).slice(1))]);
}

function taprootAccountPrivateKey(childPrivateKey: Uint8Array): Uint8Array {
  const point = secp256k1.Point.fromPrivateKey(childPrivateKey);
  let scalar = BigInt(`0x${toHex(childPrivateKey)}`);
  if (point.y & 1n) scalar = secp256k1.CURVE.n - scalar;
  const xOnlyKey = (point.y & 1n ? point.negate() : point).toBytes(true).slice(1);
  const tweak = BigInt(`0x${toHex(taggedHash('TapTweak', xOnlyKey))}`);
  if (tweak >= secp256k1.CURVE.n) throw new Error('Invalid Taproot tweak');
  const accountScalar = (scalar + tweak) % secp256k1.CURVE.n;
  if (accountScalar === 0n) throw new Error('Invalid Taproot account key');
  return bigintTo32Bytes(accountScalar);
}

function bigintTo32Bytes(value: bigint): Uint8Array {
  const output = new Uint8Array(32);
  let remaining = value;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function nativeSegwitAddressFromPublicKey(publicKey: Uint8Array): string {
  return bech32.encode('bc', [0, ...bech32.toWords(ripemd160(sha256(publicKey)))]);
}

function malformedLegacyBitcoinAddressFromPublicKey(publicKey: Uint8Array): string {
  return bech32.encode('bc', bech32.toWords(ripemd160(sha256(publicKey))));
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(encoder.encode(tag));
  return sha256(Uint8Array.from([...tagHash, ...tagHash, ...message]));
}

export function migrateLegacyBitcoinAddresses(payload: VaultPayload): boolean {
  const bitcoinAccounts = payload.accounts.filter((account) => account.family === 'bitcoin');
  if (bitcoinAccounts.length === 0) return false;
  const seed = mnemonicToSeedSync(payload.recoveryMnemonic);
  let taprootPrivateKey: Uint8Array | undefined;
  let taprootAccountKey: Uint8Array | undefined;
  let nativeSegwitPrivateKey: Uint8Array | undefined;
  let migrated = false;
  try {
    const taprootNode = HDKey.fromMasterSeed(seed).derive(BITCOIN_TAPROOT_PATH);
    const nativeSegwitNode = HDKey.fromMasterSeed(seed).derive(BITCOIN_NATIVE_SEGWIT_PATH);
    if (!taprootNode.privateKey || !taprootNode.publicKey ||
        !nativeSegwitNode.privateKey || !nativeSegwitNode.publicKey) {
      throw new Error('Unable to derive Bitcoin accounts');
    }
    taprootPrivateKey = Uint8Array.from(taprootNode.privateKey);
    taprootAccountKey = taprootAccountPrivateKey(taprootPrivateKey);
    nativeSegwitPrivateKey = Uint8Array.from(nativeSegwitNode.privateKey);
    const standardTaprootAddress = bitcoinAddressFromPublicKey(taprootNode.publicKey);
    const taprootAddress = bitcoinAddressFromPublicKey(secp256k1.getPublicKey(taprootAccountKey, true));
    const nativeSegwitAddress = nativeSegwitAddressFromPublicKey(nativeSegwitNode.publicKey);
    for (const account of bitcoinAccounts) {
      if (account.derivationPath === BITCOIN_NATIVE_SEGWIT_PATH) continue;
      if (!/^0x[0-9a-fA-F]{64}$/.test(account.privateKey)) continue;
      const publicKey = getBytesFromHex(new SigningKey(account.privateKey).compressedPublicKey.slice(2));
      const normalizedPrivateKey = account.privateKey.toLowerCase();
      const isDefaultChildKey = normalizedPrivateKey === `0x${toHex(taprootPrivateKey)}`;
      const isCompatibleAccountKey = normalizedPrivateKey === `0x${toHex(taprootAccountKey)}`;
      const legacy = account.address === nativeSegwitAddressFromPublicKey(publicKey)
        || account.address === malformedLegacyBitcoinAddressFromPublicKey(publicKey)
        || (isDefaultChildKey && account.address === standardTaprootAddress);
      if (legacy || isDefaultChildKey || isCompatibleAccountKey) {
        const compatiblePrivateKey = `0x${toHex(taprootAccountKey)}`;
        if (account.privateKey !== compatiblePrivateKey || account.address !== taprootAddress ||
            account.derivationPath !== BITCOIN_TAPROOT_PATH) {
          account.privateKey = compatiblePrivateKey;
          account.address = taprootAddress;
          account.derivationPath = BITCOIN_TAPROOT_PATH;
          migrated = true;
        }
      } else if (account.address === bitcoinAddressFromPublicKey(publicKey) && !account.derivationPath) {
        account.derivationPath = BITCOIN_TAPROOT_PATH;
        migrated = true;
      }
    }
    if (payload.accounts.length < MAX_ACCOUNTS && !payload.accounts.some((account) =>
      account.family === 'bitcoin' && account.derivationPath === BITCOIN_NATIVE_SEGWIT_PATH
    )) {
      payload.accounts.push({
        id: crypto.randomUUID(),
        name: 'Bitcoin Native SegWit',
        family: 'bitcoin',
        address: nativeSegwitAddress,
        privateKey: `0x${toHex(nativeSegwitPrivateKey)}`,
        derivationPath: BITCOIN_NATIVE_SEGWIT_PATH,
      });
      migrated = true;
    }
  } finally {
    seed.fill(0);
    taprootPrivateKey?.fill(0);
    taprootAccountKey?.fill(0);
    nativeSegwitPrivateKey?.fill(0);
  }
  return migrated;
}

function tronAddressFromPrivateKey(privateKey: string): string {
  const evmAddress = computeAddress(privateKey);
  const payload = Uint8Array.from([0x41, ...getBytesFromHex(evmAddress.slice(2))]);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return bs58.encode(Uint8Array.from([...payload, ...checksum]));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function getBytesFromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error('Invalid hex value');
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [],
    (part) => Number.parseInt(part, 16),
  );
}

function deriveEd25519Path(seed: Uint8Array, path: string): Uint8Array {
  let digest = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = digest.slice(0, 32);
  let chainCode = digest.slice(32);
  for (const segment of path.split('/').slice(1)) {
    if (!segment.endsWith("'")) {
      throw new Error('SLIP-0010 Ed25519 paths must be hardened');
    }
    const value = Number.parseInt(segment.slice(0, -1), 10) + 0x80000000;
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, value, false);
    const nextDigest = hmac(sha512, chainCode, data);
    digest.fill(0);
    key.fill(0);
    chainCode.fill(0);
    digest = nextDigest;
    key = digest.slice(0, 32);
    chainCode = digest.slice(32);
  }
  digest.fill(0);
  chainCode.fill(0);
  return key;
}
