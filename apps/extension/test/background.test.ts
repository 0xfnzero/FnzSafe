import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptVault } from '../src/vault';
let listener: (message: Record<string, unknown>, sender: unknown, respond: (r: any) => void) => unknown;
const storage: Record<string, unknown> = {};
let failWrite = false;
const noopEvent = { addListener() {} };
Object.assign(globalThis, { chrome: {
  runtime: { id: 'fixture-extension', getURL: (path: string) => `chrome-extension://fixture-extension/${path}`,
    onConnect: noopEvent, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onSuspend: noopEvent },
  storage: { local: {
    async get(keys: string | string[]) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.map(k => [k, storage[k]])); },
    async set(values: Record<string, unknown>) { if (failWrite) { failWrite = false; throw new Error('Simulated storage failure'); } Object.assign(storage, values); },
    async remove(key: string) { delete storage[key]; },
  } }, alarms: { async create() {}, async clear() {}, onAlarm: noopEvent },
  windows: { onRemoved: noopEvent },
} });
await import('../src/background');
function send(message: Record<string, unknown>, url = 'chrome-extension://fixture-extension/popup.html'): Promise<any> {
  return new Promise(r => listener(message, { id: 'fixture-extension', url }, r));
}
test('background rejects website callers and serializes imports without losing existing wallet secrets', async () => {
  assert.equal((await send({ type: 'STATUS' }, 'https://dapp.example/')).ok, false);
  assert.equal((await send({ type: 'CREATE_VAULT', password: 'fixture-password', mnemonic: 'test test test test test test test test test test test junk' })).ok, true);
  const imported = await Promise.all(['1', '2'].map(key => send({ type: 'IMPORT_ACCOUNTS', password: 'fixture-password', import: { kind: 'privateKey', family: 'evm', text: key.padStart(64, '0') } })));
  assert.ok(imported.every(r => r.ok));
  const exported = await send({ type: 'EXPORT_BACKUP', password: 'fixture-password' });
  const payload = await decryptVault(exported.result, 'fixture-password');
  assert.equal(payload.accounts.length, 7);
  assert.equal(payload.recoveryMnemonic, 'test test test test test test test test test test test junk');
  const status = await send({ type: 'STATUS' });
  assert.equal(JSON.stringify(status).includes('privateKey'), false);
  assert.equal(JSON.stringify(status).includes('test test'), false);
  const before = JSON.stringify(storage.encryptedVault);
  assert.equal((await send({ type: 'IMPORT_ACCOUNTS', password: 'incorrect-password', import: { kind: 'privateKey', family: 'evm', text: '3'.padStart(64, '0') } })).ok, false);
  assert.equal(JSON.stringify(storage.encryptedVault), before);
  await send({ type: 'LOCK' });
  assert.equal((await send({ type: 'EXPORT_BACKUP', password: 'fixture-password' })).ok, false);
  assert.equal((await send({ type: 'STATUS' })).result.accounts.length, 0);
  await send({ type: 'UNLOCK', password: 'fixture-password' });
  assert.equal((await send({ type: 'STATUS' })).result.accounts.length, 7);
  await send({ type: 'LOCK' });
});

test('first open creates one recoverable wallet; protection preserves addresses and cannot lose the device copy on failed writes', async () => {
  await send({ type: 'LOCK' });
  for (const key of Object.keys(storage)) delete storage[key];
  const results = await Promise.all([send({ type: 'OPEN_WALLET' }), send({ type: 'OPEN_WALLET' })]);
  assert.ok(results.every(r => r.ok));
  const before = (await send({ type: 'STATUS' })).result;
  assert.equal(before.initialized, true); assert.equal(before.passwordProtected, false);
  assert.equal(before.accounts.length, 5);
  assert.equal((await send({ type: 'GET_RECOVERY_PHRASE', password: '' })).ok, false);
  const blocked = await send({ type: 'SEND_NATIVE', family: 'evm', accountId: before.settings.activeAccountId, chainKey: 'evm:1', recipient: '0x0000000000000000000000000000000000000001', amount: '0.1' });
  assert.equal(blocked.ok, false); assert.match(blocked.error, /password before signing/);
  await send({ type: 'LOCK' }); await send({ type: 'OPEN_WALLET' });
  assert.deepEqual((await send({ type: 'STATUS' })).result.accounts, before.accounts);
  failWrite = true;
  assert.equal((await send({ type: 'PROTECT_DEFAULT_WALLET', password: 'test-default-password' })).ok, false);
  assert.equal(storage.encryptedVault, undefined);
  const passkey = { credentialId: '01'.repeat(32), salt: '02'.repeat(32), rpId: 'fixture-extension' };
  assert.equal((await send({ type: 'PROTECT_DEFAULT_WALLET', password: '09'.repeat(32), passkey })).ok, true);
  await send({ type: 'LOCK' }); await send({ type: 'OPEN_WALLET' });
  assert.equal((await send({ type: 'STATUS' })).result.locked, true);
  assert.equal((await send({ type: 'UNLOCK', password: 'incorrect-secret' })).ok, false);
  assert.equal((await send({ type: 'UNLOCK', password: '09'.repeat(32) })).ok, true);
  assert.deepEqual((await send({ type: 'STATUS' })).result.accounts, before.accounts);
  const exported = await send({ type: 'EXPORT_BACKUP', password: '09'.repeat(32), backupPassword: 'portable-backup-password' });
  const payload = await decryptVault(exported.result, 'portable-backup-password');
  assert.equal(payload.accounts[0].address, before.accounts[0].address);
  assert.equal(payload.recoveryMnemonic.split(' ').length, 12);
  assert.equal((await send({ type: 'GET_RECOVERY_PHRASE', password: '09'.repeat(32) })).result, payload.recoveryMnemonic);
  const { loadDeviceWallet } = await import('../src/device-vault');
  assert.equal(await loadDeviceWallet(), null);
  await send({ type: 'LOCK' });
});
