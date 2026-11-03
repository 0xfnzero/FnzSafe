import { argon2idAsync } from '@noble/hashes/argon2';

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
/** Desktop SecretEnvelopeV1: Argon2id + AES-256-GCM with the desktop AAD. */
export async function encryptSecretBackup(secret: string, password: string): Promise<string> {
  if (password.length < 10 || password.length > 1024) throw new Error('Use a backup password with 10–1024 characters');
  const clear = new TextEncoder().encode(secret);
  if (!clear.length || clear.length > 16384) throw new Error('Invalid backup secret');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await argon2idAsync(password, salt, { m: 65536, t: 3, p: 1, dkLen: 32, asyncTick: 10, maxmem: 70 * 1024 * 1024 });
  try {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(bytes), 'AES-GCM', false, ['encrypt']);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('fnzsafe-secret-envelope-v1') }, key, clear));
    return JSON.stringify({ version: 1, kind: 'password-secret', crypto: { kdf: 'argon2id', kdf_params: { memory_kib: 65536, iterations: 3, parallelism: 1, salt: encode(salt) }, cipher: 'aes-256-gcm', nonce: encode(iv), ciphertext: encode(ciphertext) }, created_at: new Date().toISOString() });
  } finally { bytes.fill(0); clear.fill(0); }
}
/** Desktop-compatible ordered fragments, not threshold secret sharing. */
export function splitBackupSecret(value: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('Choose 1–12 segments');
  const words = value.trim().split(/\s+/);
  const parts = words.length > 1 ? words : Array.from(value);
  if (count > parts.length) throw new Error('Too many segments');
  const size = Math.floor(parts.length / count), remainder = parts.length % count;
  let offset = 0;
  return Array.from({ length: count }, (_, i) => { const n = size + (i < remainder ? 1 : 0); const part = parts.slice(offset, offset + n); offset += n; return part.join(words.length > 1 ? ' ' : ''); });
}
