import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptVault } from '../src/vault';
let connectListener: (port: any) => void;
let listener: (message: Record<string, unknown>, sender: unknown, respond: (r: any) => void) => unknown;
const storage: Record<string, unknown> = {};
let failWrite = false;
let lastAlarm = 0;
let alarmListener: (alarm: { name: string }) => void;
const noopEvent = { addListener() {} };
Object.assign(globalThis, { chrome: {
  runtime: { id: 'fixture-extension', getURL: (path: string) => `chrome-extension://fixture-extension/${path}`,
    onConnect: { addListener(fn: typeof connectListener) { connectListener = fn; } }, onMessage: { addListener(fn: typeof listener) { listener = fn; } }, onSuspend: noopEvent },
  storage: { local: {
    async get(keys: string | string[]) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.map(k => [k, storage[k]])); },
    async set(values: Record<string, unknown>) { if (failWrite) { failWrite = false; throw new Error('Simulated storage failure'); } Object.assign(storage, values); },
    async remove(key: string) { delete storage[key]; },
  } }, alarms: { async create(_name: string, options: { when: number }) { lastAlarm = options.when; }, async clear() { lastAlarm = 0; }, onAlarm: { addListener(fn: typeof alarmListener) { alarmListener = fn; } } },
  windows: { onRemoved: noopEvent },
} });
await import('../src/background');
test.after(async () => { await send({ type: 'LOCK' }); });
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

test('one-click wallet groups persist all chain roots, scope exports, and preserve the old vault on failure', async () => {
  await send({ type: 'LOCK' });
  for (const key of Object.keys(storage)) delete storage[key];
  assert.equal((await send({ type: 'OPEN_WALLET' })).ok, true);
  const first = (await send({ type: 'STATUS' })).result;
  assert.equal((await send({ type: 'CREATE_WALLET' })).ok, true);
  let status = (await send({ type: 'STATUS' })).result;
  assert.equal(status.wallets.length, 2); assert.equal(status.accounts.length, 10);
  assert.notEqual(first.activeWalletId, status.activeWalletId);
  assert.deepEqual(status.accounts.slice(0, 5), first.accounts);
  const { loadDeviceWallet } = await import('../src/device-vault');
  const device = (await loadDeviceWallet())!;
  assert.notEqual(device.wallets![0].recoveryMnemonic, device.wallets![1].recoveryMnemonic);
  for (const w of device.wallets!) assert.deepEqual(new Set(device.accounts.filter(a => a.walletId === w.id).map(a => a.family)), new Set(['evm', 'solana', 'bitcoin', 'tron']));
  assert.equal((await send({ type: 'PROTECT_DEFAULT_WALLET', password: 'multi-wallet-password' })).ok, true);
  const previous = JSON.stringify(storage.encryptedVault);
  failWrite = true;
  assert.equal((await send({ type: 'CREATE_WALLET' })).ok, false);
  assert.equal(JSON.stringify(storage.encryptedVault), previous);
  assert.equal((await send({ type: 'STATUS' })).result.wallets.length, 2);
  assert.equal((await send({ type: 'CREATE_WALLET' })).ok, true);
  status = (await send({ type: 'STATUS' })).result;
  assert.equal(status.wallets.length, 3); assert.equal(status.accounts.length, 15);
  assert.equal(JSON.stringify(status).includes('recoveryMnemonic'), false);
  const exported = await send({ type: 'EXPORT_BACKUP', password: 'multi-wallet-password' });
  assert.equal(exported.result.version, 2);
  const restored = await decryptVault(exported.result, 'multi-wallet-password');
  assert.equal(restored.wallets!.length, 3);
  assert.deepEqual(restored.accounts.slice(0, 10), device.accounts);
  assert.deepEqual(restored.wallets!.slice(0, 2), device.wallets);
  const wallet = restored.wallets![1], account = restored.accounts.find(a => a.walletId === wallet.id && a.family === 'solana')!;
  const request = { type: 'EXPORT_SECRET', walletId: wallet.id, accountId: account.id, password: 'multi-wallet-password', kind: 'privateKey', format: 'plaintext' };
  assert.equal((await send(request)).result.value, account.privateKey);
  assert.equal((await send({ ...request, kind: 'mnemonic' })).result.value, wallet.recoveryMnemonic);
  assert.equal((await send({ ...request, walletId: restored.wallets![0].id })).ok, false);
  assert.equal((await send({ ...request, password: 'wrong' })).ok, false);
  const btc = restored.accounts.find(a => a.walletId === wallet.id && a.family === 'bitcoin' && a.address.startsWith('bc1p'))!;
  const btcBackup = await send({ ...request, accountId: btc.id, format: 'encrypted', backupPassword: 'bitcoin-backup-password' });
  assert.equal(btcBackup.ok, true);
  const btcRestored = await decryptVault(JSON.parse(btcBackup.result.value), 'bitcoin-backup-password');
  assert.equal(btcRestored.accounts.length, 1); assert.equal(btcRestored.accounts[0].address, btc.address);
  await send({ type: 'CONFIRM_BACKUP', walletId: wallet.id });
  await send({ type: 'SET_ACTIVE_ACCOUNT', accountId: account.id });
  status = (await send({ type: 'STATUS' })).result;
  assert.equal(status.activeWalletId, wallet.id); assert.equal(status.backupConfirmed, true);
  await send({ type: 'SET_ACTIVE_ACCOUNT', accountId: restored.accounts[0].id });
  assert.equal((await send({ type: 'STATUS' })).result.backupConfirmed, false);
  await send({ type: 'LOCK' });
  assert.equal((await send({ type: 'CREATE_WALLET' })).ok, false);
  assert.equal((await send(request)).ok, false);
  await send({ type: 'UNLOCK', password: 'multi-wallet-password' });
  assert.equal((await send({ type: 'STATUS' })).result.wallets.length, 3);
  await send({ type: 'LOCK' });
});


test('wallet and network selection is atomic, rejects mismatches, and idle duration follows real UI activity', async () => {
  assert.equal((await send({ type: 'UNLOCK', password: 'multi-wallet-password' })).ok, true);
  let status = (await send({ type: 'STATUS' })).result;
  assert.equal(status.settings.autoLockMinutes, 15);
  const secondWallet = status.wallets[1].id;
  const evm = status.accounts.find((a: any) => a.walletId === secondWallet && a.family === 'evm');
  const solana = status.accounts.find((a: any) => a.walletId === secondWallet && a.family === 'solana');
  assert.equal((await send({ type: 'SELECT_WALLET_ACCOUNT', accountId: evm.id, chainKey: 'evm:56' })).ok, true);
  status = (await send({ type: 'STATUS' })).result;
  assert.equal(status.activeWalletId, secondWallet); assert.equal(status.settings.evmChainId, 56);
  assert.equal((await send({ type: 'SELECT_WALLET_ACCOUNT', accountId: solana.id, chainKey: 'solana:devnet' })).ok, true);
  status = (await send({ type: 'STATUS' })).result;
  assert.equal(status.settings.activeAccountId, solana.id); assert.equal(status.settings.solanaCluster, 'devnet');
  const before = status.settings;
  assert.equal((await send({ type: 'SELECT_WALLET_ACCOUNT', accountId: solana.id, chainKey: 'evm:1' })).ok, false);
  assert.deepEqual((await send({ type: 'STATUS' })).result.settings, before);
  failWrite = true;
  assert.equal((await send({ type: 'SELECT_WALLET_ACCOUNT', accountId: evm.id, chainKey: 'evm:137' })).ok, false);
  assert.deepEqual((await send({ type: 'STATUS' })).result.settings, before);
  assert.equal((await send({ type: 'SET_AUTO_LOCK', minutes: 30 })).ok, true);
  await send({ type: 'TOUCH_SESSION' });
  await new Promise(r => setImmediate(r));
  assert.ok(Math.abs(lastAlarm - Date.now() - 30 * 60000) < 1000);
  const alarm = lastAlarm;
  await send({ type: 'STATUS' }); await send({ type: 'SESSION_STATUS' });
  assert.equal(lastAlarm, alarm);
  assert.equal((await send({ type: 'TOUCH_SESSION' }, 'https://dapp.example/')).ok, false);
  assert.equal((await send({ type: 'SET_AUTO_LOCK', minutes: 0 })).ok, false);
  alarmListener({ name: 'fnzsafe-lock' });
  assert.equal((await send({ type: 'STATUS' })).result.locked, true);
  assert.equal((await send({ type: 'TOUCH_SESSION' })).ok, true);
  assert.equal(lastAlarm, 0);
  await send({ type: 'UNLOCK', password: 'multi-wallet-password' });
  assert.equal((await send({ type: 'STATUS' })).result.settings.autoLockMinutes, 30);
  await send({ type: 'LOCK' });
});


test('DApp account fallback stays inside the selected mnemonic wallet and cannot reuse another wallet permission', async () => {
  await send({ type: 'UNLOCK', password: 'multi-wallet-password' });
  const status = (await send({ type: 'STATUS' })).result;
  const evm = status.accounts.find((a: any) => a.family === 'evm' && a.walletId === status.wallets[1].id);
  const solana = status.accounts.find((a: any) => a.family === 'solana' && a.walletId === status.wallets[1].id);
  const other = status.accounts.find((a: any) => a.family === 'evm' && a.walletId === status.wallets[0].id);
  storage.originPermissions = { 'https://dapp.example': { families: ['evm'], accountIds: [evm.id], evmChainIds: [56], solanaClusters: [], grantedAt: Date.now() } };
  let providerListener: (r: any) => void;
  let respond: (r: any) => void;
  connectListener({ name: 'fnzsafe-provider', sender: { url: 'https://dapp.example/', frameId: 0 }, onMessage: { addListener(fn: typeof providerListener) { providerListener = fn; } }, onDisconnect: noopEvent, postMessage(message: any) { respond(message); }, disconnect() {} });
  function provider() { return new Promise<any>(resolve => { respond = resolve; providerListener({ channel: 'fnzsafe:provider', id: crypto.randomUUID(), family: 'evm', method: 'eth_accounts', params: [] }); }); }
  await send({ type: 'SELECT_WALLET_ACCOUNT', accountId: solana.id, chainKey: 'solana:mainnet-beta' });
  await send({ type: 'SET_NETWORK', key: 'evm:56' });
  assert.deepEqual((await provider()).result, [evm.address]);
  await send({ type: 'SELECT_WALLET_ACCOUNT', accountId: other.id, chainKey: 'evm:56' });
  assert.deepEqual((await provider()).result, []);
  await send({ type: 'LOCK' });
  assert.deepEqual((await provider()).result, []);
});

test('DApp network switching requires approval; unknown networks return 4902 without a broken popup', async () => {
  await send({ type: 'UNLOCK', password: 'multi-wallet-password' });
  let providerListener: (r: any) => void;
  let respond: (r: any) => void;
  let opened: (id: string) => void = () => {};
  let popupCount = 0;
  Object.assign(chrome.windows, {
    async get(id: number) { assert.equal(id, 321); return { left: -1280, top: 20, width: 1200, height: 640 }; },
    async create(options: chrome.windows.CreateData) {
      assert.equal(options.width, 380);
      assert.equal(options.height, 640, 'confirmation fits a shorter browser window');
      assert.equal(options.left, -460, 'keep the popup on the requesting monitor, aligned right');
      assert.equal(options.top, 20);
      popupCount++; opened(new URL(options.url as string).searchParams.get('id')!); return { id: 123 };
    },
    async remove() {},
  });
  connectListener({ name: 'fnzsafe-provider', sender: { url: 'https://network-test.example/', frameId: 0, tab: { windowId: 321 } },
    onMessage: { addListener(fn: typeof providerListener) { providerListener = fn; } }, onDisconnect: noopEvent,
    postMessage(message: any) { respond(message); }, disconnect() {} });
  function provider(method: string, params: any[] = []) {
    return new Promise<any>(resolve => { respond = resolve; providerListener({ channel: 'fnzsafe:provider', id: crypto.randomUUID(), family: 'evm', method, params }); });
  }
  for (const method of ['wallet_addEthereumChain', 'wallet_switchEthereumChain']) {
    const result = await provider(method, [{ chainId: '0xffffff' }]);
    assert.equal(result.error.code, 4902);
  }
  assert.equal(popupCount, 0);
  let ready = new Promise<string>(resolve => { opened = resolve; });
  let response = provider('eth_requestAccounts');
  let id = await ready;
  assert.equal((await send({ type: 'RESOLVE_PENDING', id, approved: true })).ok, true);
  assert.equal((await response).result.length, 1);
  const before = (await send({ type: 'STATUS' })).result.settings.evmChainId;
  ready = new Promise<string>(resolve => { opened = resolve; });
  response = provider('wallet_switchEthereumChain', [{ chainId: '0x61' }]);
  id = await ready;
  const view = await send({ type: 'GET_PENDING', id });
  assert.equal(view.ok, true);
  assert.ok(view.result.details.some((d: any) => d.value === 'BNB Smart Chain Testnet (97)'));
  assert.equal((await send({ type: 'STATUS' })).result.settings.evmChainId, before);
  assert.equal((await send({ type: 'RESOLVE_PENDING', id, approved: true })).ok, true);
  assert.equal((await response).result, null);
  assert.equal((await provider('eth_chainId')).result, '0x61');
  await send({ type: 'LOCK' });
});
