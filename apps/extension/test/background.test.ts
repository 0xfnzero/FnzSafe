import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptVault } from '../src/vault';
let listener: (message: Record<string, unknown>, sender: unknown, respond: (r: any) => void) => unknown;
const storage: Record<string, unknown> = {};
const noopEvent = { addListener() {} };
Object.assign(globalThis, { chrome: {
  runtime: { id: 'fixture-extension', getURL: (path: string) => `chrome-extension://fixture-extension/${path}`,
    onConnect: noopEvent, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onSuspend: noopEvent },
  storage: { local: {
    async get(keys: string | string[]) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.map(k => [k, storage[k]])); },
    async set(values: Record<string, unknown>) { Object.assign(storage, values); },
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
