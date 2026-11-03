import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureDeviceWallet, loadDeviceWallet, removeDeviceWallet } from '../src/device-vault';

test('default wallet creation is durable, encrypted and atomic across concurrent first opens', async () => {
  await removeDeviceWallet();
  const [a, b] = await Promise.all([ensureDeviceWallet(), ensureDeviceWallet()]);
  assert.equal(a.recoveryMnemonic, b.recoveryMnemonic);
  assert.equal(a.accounts[0].address, b.accounts[0].address);
  assert.equal((await loadDeviceWallet())!.accounts[0].address, a.accounts[0].address);
  const db = await new Promise<IDBDatabase>(r => { const q = indexedDB.open('fnzsafe-device-vault', 1); q.onsuccess = () => r(q.result); });
  const stored = await new Promise<any>(r => { const q = db.transaction('vault').objectStore('vault').get('default'); q.onsuccess = () => r(q.result); });
  assert.equal(stored.key.extractable, false);
  assert.equal(JSON.stringify(stored).includes(a.recoveryMnemonic), false);
  assert.equal(JSON.stringify(stored).includes(a.accounts[0].privateKey), false);
  await assert.rejects(crypto.subtle.exportKey('raw', stored.key));
  stored.ciphertext[0] ^= 1;
  await new Promise<void>(r => { const tx = db.transaction('vault', 'readwrite'); tx.objectStore('vault').put(stored, 'default'); tx.oncomplete = () => r(); });
  db.close();
  await assert.rejects(ensureDeviceWallet()); // corruption must not silently replace the account
  await removeDeviceWallet();
});
