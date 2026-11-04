// Isolated defensive audit: public BIP39 fixture, fake IndexedDB, memory-only Chrome.
// Regression assertions: stale work must fail closed after lock or selection change.
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
let listener: any; let connectListener: any; let opened: (id: string) => void = () => {};
const storage: Record<string, any> = {};
let hold: ((keys: string[]) => Promise<void>) | undefined;
let holdWrite: (() => Promise<void>) | undefined;
const event = { addListener() {} };
Object.assign(globalThis, { chrome: {
  runtime: { id: 'fixture-extension', getURL: (p: string) => `chrome-extension://fixture-extension/${p}`,
    onConnect: { addListener(fn: any) { connectListener = fn; } }, onMessage: { addListener(fn: any) { listener = fn; } }, onSuspend: event },
  storage: { local: {
    async get(keys: string | string[]) { const list = Array.isArray(keys) ? keys : [keys]; if (hold) await hold(list); return Object.fromEntries(list.map(k => [k, storage[k]])); },
    async set(values: Record<string, any>) { if (holdWrite) await holdWrite(); Object.assign(storage, values); },
    async remove(key: string) { delete storage[key]; },
  } },
  alarms: { async create() {}, async clear() {}, onAlarm: event },
  action: { async setBadgeBackgroundColor() {}, async setBadgeTextColor() {}, async setBadgeText() {}, async setTitle() {} },
  windows: { onRemoved: event, async get() { return { left: 0, top: 0, width: 1200, height: 800 }; }, async create(options: any) { opened(new URL(options.url).searchParams.get("id")!); return { id: 123 }; }, async remove() {} },
} });
await import('../src/background');
const send = (message: Record<string, unknown>): Promise<any> => new Promise(resolve => listener(message, { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/popup.html' }, resolve));
function pause(key: string) {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>(r => reached = r), gate = new Promise<void>(r => release = r);
  hold = async keys => { if (keys.includes(key)) { hold = undefined; reached(); await gate; } };
  return { started, release };
}

const password = 'public-audit-fixture-password';
const mnemonic = 'test test test test test test test test test test test junk';
async function reset() {
  hold = undefined;
  await send({ type: 'LOCK' });
  for (const key of Object.keys(storage)) delete storage[key];
  assert.equal((await send({ type: 'CREATE_VAULT', password, mnemonic })).ok, true);
}
test.after(async () => { hold = undefined; await send({ type: 'LOCK' }); });

test('LOCK during the first vault read cancels ordinary UNLOCK', { timeout: 10_000 }, async () => {
  await reset(); await send({ type: 'LOCK' });
  const gate = pause('encryptedVault');
  const unlocking = send({ type: 'UNLOCK', password });
  try {
    await gate.started;
    assert.equal((await send({ type: 'LOCK' })).ok, true);
    gate.release();
    assert.equal((await unlocking).ok, false);
    assert.equal((await send({ type: 'SESSION_STATUS' })).result.locked, true);
    assert.equal((await send({ type: 'UNLOCK', password })).ok, true, 'a fresh user unlock still works');
  } finally { gate.release(); hold = undefined; }
});

test('LOCK during the last settings read prevents plaintext recovery response', { timeout: 10_000 }, async () => {
  await reset();
  const walletId = (await send({ type: 'STATUS' })).result.wallets[0].id;
  const gate = pause('walletSettings');
  const exporting = send({ type: 'GET_RECOVERY_PHRASE', password, walletId });
  try {
    await gate.started;
    await send({ type: 'LOCK' });
    gate.release();
    const result = await exporting;
    assert.equal(result.ok, false);
    assert.equal(result.result, undefined);
    assert.equal((await send({ type: 'SESSION_STATUS' })).result.locked, true);
    await send({ type: 'UNLOCK', password });
    assert.equal((await send({ type: 'GET_RECOVERY_PHRASE', password, walletId })).result, mnemonic);
  } finally { gate.release(); hold = undefined; }
});

for (const transition of ['switch', 'lock', 'unchanged']) {
  test(`Solana approval preserves its original signer across permission waits: ${transition}`, { timeout: 10_000 }, async () => {
    await reset();
    assert.equal((await send({ type: 'IMPORT_ACCOUNTS', password, import: { kind: 'mnemonic', family: 'solana', text: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' } })).ok, true);
    const [approved, other] = (await send({ type: 'STATUS' })).result.accounts.filter((a: any) => a.family === 'solana');
    await send({ type: 'SET_ACTIVE_ACCOUNT', accountId: approved.id });
    storage.originPermissions = { 'https://fixture.invalid': { families: ['solana'], accountIds: [approved.id], evmChainIds: [], solanaClusters: ['mainnet-beta'], grantedAt: Date.now() } };
    let receive: any; const responses: any[] = [];
    connectListener({ name: 'fnzsafe-provider', sender: { url: 'https://fixture.invalid/', frameId: 0, tab: { windowId: 1 } },
      onMessage: { addListener(fn: any) { receive = fn; } }, onDisconnect: event,
      postMessage(value: any) { responses.push(value); }, disconnect() {} });
    const ready = new Promise<string>(r => opened = r);
    receive({ channel: 'fnzsafe:provider', id: 'audit-message', family: 'solana', method: 'solana_signMessage', params: [Buffer.from('FnzSafe harmless regression text; no transaction or authorization').toString('base64')] });
    const id = await ready;
    assert.equal((await send({ type: 'GET_PENDING', id })).ok, true);
    const gate = pause('originPermissions');
    const resolving = send({ type: 'RESOLVE_PENDING', id, approved: true });
    try {
      await gate.started;
      if (transition === 'switch') assert.equal((await send({ type: 'SET_ACTIVE_ACCOUNT', accountId: other.id })).ok, true);
      if (transition === 'lock') assert.equal((await send({ type: 'LOCK' })).ok, true);
      gate.release();
      const result = await resolving;
      assert.equal(result.ok, transition === 'unchanged');
      assert.equal(responses.length, 1);
      if (transition === 'unchanged') {
        assert.equal(responses[0].result.publicKey, approved.address);
        assert.ok(responses[0].result.signature);
      } else {
        assert.equal(responses[0].result, undefined);
        assert.ok(responses[0].error);
      }
      assert.equal(storage.originPermissions['https://fixture.invalid'].accountIds.includes(other.id), false);
      assert.equal((await send({ type: 'GET_PENDING_REQUESTS' })).result.length, 0);
    } finally { gate.release(); hold = undefined; }
  });
}


test('revoking permissions waits for and removes an in-flight connection grant', { timeout: 10_000 }, async () => {
  await reset();
  let receive: any; const responses: any[] = [];
  connectListener({ name: 'fnzsafe-provider', sender: { url: 'https://revoke.invalid/', frameId: 0, tab: { windowId: 1 } },
    onMessage: { addListener(fn: any) { receive = fn; } }, onDisconnect: event,
    postMessage(value: any) { responses.push(value); }, disconnect() {} });
  const ready = new Promise<string>(r => opened = r);
  receive({ channel: 'fnzsafe:provider', id: 'grant-revoke-race', family: 'evm', method: 'eth_requestAccounts', params: [] });
  const id = await ready;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  holdWrite = async () => { holdWrite = undefined; entered(); await gate; };
  const approving = send({ type: 'RESOLVE_PENDING', id, approved: true });
  try {
    await started;
    const revoking = send({ type: 'CLEAR_PERMISSIONS' });
    release();
    assert.equal((await approving).ok, false);
    assert.equal((await revoking).ok, true);
    assert.equal(storage.originPermissions, undefined);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].result, undefined);
  } finally { release(); holdWrite = undefined; }
});
