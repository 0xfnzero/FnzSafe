import { protectVaultInMemory, decryptSessionVault, type UnlockedVaultSession } from './memory-vault';
import { createInitialVault, validateVaultPayload } from './vault';
import type { VaultPayload } from './types';

// A browser-bound starting wallet, not password protection. The non-exportable
// key and authenticated ciphertext are committed together in IndexedDB.
const database = 'fnzsafe-device-vault';
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vault');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Unable to open local wallet storage'));
  });
}
async function stored(candidate?: UnlockedVaultSession): Promise<UnlockedVaultSession | undefined> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('vault', candidate ? 'readwrite' : 'readonly');
      const store = tx.objectStore('vault');
      const request = store.get('default');
      let result: UnlockedVaultSession | undefined;
      request.onsuccess = () => {
        result = request.result;
        if (!result && candidate) { result = candidate; store.add(candidate, 'default'); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('Unable to save local wallet; no account was replaced'));
    });
  } finally { db.close(); }
}
export async function hasDeviceWallet(): Promise<boolean> { return !!(await stored()); }
export async function loadDeviceWallet(): Promise<VaultPayload | null> {
  const value = await stored();
  if (!value) return null;
  const payload = await decryptSessionVault(value);
  validateVaultPayload(payload);
  return payload;
}
export async function ensureDeviceWallet(): Promise<VaultPayload> {
  const existing = await loadDeviceWallet();
  if (existing) return existing;
  const payload = createInitialVault();
  const candidate = await protectVaultInMemory(payload);
  const saved = await stored(candidate);
  if (!saved) throw new Error('Unable to initialize wallet');
  const restored = await decryptSessionVault(saved);
  validateVaultPayload(restored);
  return restored;
}
export async function removeDeviceWallet(): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('vault', 'readwrite');
      tx.objectStore('vault').delete('default');
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('Unable to clean up device wallet'));
    });
  } finally { db.close(); }
}
