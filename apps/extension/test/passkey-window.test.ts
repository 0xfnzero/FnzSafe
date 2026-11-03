import assert from 'node:assert/strict';
import test from 'node:test';
import { registerPasskeyWindows } from '../src/passkey-broker';
import { passkeyWindowBounds, PASSKEY_CALLER_PORT, PASSKEY_WINDOW_PORT } from '../src/passkey-window';

const rpId = 'a'.repeat(32), base = `chrome-extension://${rpId}/`;
const config = { credentialId: '01'.repeat(32), salt: '02'.repeat(32), rpId };
const tick = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners: ((...args: any[]) => void)[] = [];
  return { addListener(fn: (...args: any[]) => void) { listeners.push(fn); }, emit(...args: any[]) { listeners.forEach(fn => fn(...args)); } };
}
function setup() {
  const connect = event(), removed = event();
  const windows: any[] = [], closed: number[] = [];
  let failCreate = false;
  Object.assign(globalThis, { chrome: {
    runtime: { id: rpId, getURL: (page: string) => base + page, onConnect: connect },
    windows: { onRemoved: removed, async create(options: any) {
      if (failCreate) throw new Error('cannot create');
      const w = { ...options, id: windows.length + 1 }; windows.push(w); return w;
    }, async remove(id: number) { closed.push(id); } },
  } });
  registerPasskeyWindows();
  function port(name: string, url: string, windowId?: number) {
    const p = { name, sender: { id: rpId, url, ...(windowId === undefined ? {} : { tab: { windowId } }) },
      messages: [] as any[], disconnected: false, onMessage: event(), onDisconnect: event(),
      postMessage(message: any) { this.messages.push(message); },
      disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } },
    };
    connect.emit(p); return p;
  }
  function caller(mode = 'unlock') {
    const p = port(PASSKEY_CALLER_PORT, base + 'popup.html');
    p.onMessage.emit({ mode, config, bounds: passkeyWindowBounds({ availWidth: 1440, availHeight: 900 }) });
    return p;
  }
  return { port, caller, windows, closed, removed, failCreate() { failCreate = true; } };
}

test('Passkey window fits the available screen, including small and negative-coordinate monitors', () => {
  for (const screen of [
    { availWidth: 1440, availHeight: 900, availLeft: 0, availTop: 25 },
    { availWidth: 1920, availHeight: 1080, availLeft: -1920, availTop: -1080 },
    { availWidth: 640, availHeight: 480, availLeft: 0, availTop: 0 },
  ]) {
    const bounds = passkeyWindowBounds(screen);
    assert.ok(bounds.left >= screen.availLeft && bounds.top >= screen.availTop);
    assert.ok(bounds.left + bounds.width <= screen.availLeft + screen.availWidth);
    assert.ok(bounds.top + bounds.height <= screen.availTop + screen.availHeight);
    assert.ok(Math.abs(bounds.left + bounds.width / 2 - (screen.availLeft + screen.availWidth / 2)) <= 1);
  }
});

test('only the matching trusted Passkey window can return a one-use result to its caller', async () => {
  const h = setup();
  assert.equal(h.port(PASSKEY_CALLER_PORT, 'https://attacker.example/popup.html').disconnected, true);
  assert.equal(h.port(PASSKEY_CALLER_PORT, base + 'passkey.html').disconnected, true);
  const caller = h.caller();
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].type, 'popup');
  assert.equal(h.windows[0].focused, true);
  assert.equal(h.windows[0].url.includes(config.salt), false);
  const spoof = h.port(PASSKEY_WINDOW_PORT, h.windows[0].url, 99);
  await tick(); assert.equal(spoof.disconnected, true); assert.equal(caller.messages.length, 0);
  const child = h.port(PASSKEY_WINDOW_PORT, h.windows[0].url, 1);
  await tick(); assert.deepEqual(child.messages, [{ mode: 'unlock', config }]);
  child.onMessage.emit({ result: { password: '09'.repeat(32) } });
  child.onMessage.emit({ result: { password: '08'.repeat(32) } });
  await tick();
  assert.deepEqual(caller.messages, [{ result: { password: '09'.repeat(32) } }]);
  assert.equal(child.disconnected, true); assert.equal(caller.disconnected, true);
  assert.deepEqual(h.closed, [1]);
  assert.equal(h.port(PASSKEY_WINDOW_PORT, h.windows[0].url, 1).disconnected, true);
});

test('Passkey window close, original page exit and opening failure all end the request', async () => {
  const h = setup();
  const caller = h.caller();
  h.removed.emit(1); await tick();
  assert.match(caller.messages[0].error, /cancelled/);
  const other = h.caller(); other.disconnect(); await tick();
  assert.deepEqual(h.closed, [1, 2]);
  h.failCreate(); const failed = h.caller(); await tick();
  assert.match(failed.messages[0].error, /Unable to open/);
});

test('Passkey enrollment rejects foreign configuration and malformed secrets', async () => {
  const h = setup();
  for (const result of [
    { password: '09'.repeat(32), config: { ...config, rpId: 'foreign' } },
    { password: 'bad', config },
  ]) {
    const caller = h.caller('create'), w = h.windows.at(-1);
    const child = h.port(PASSKEY_WINDOW_PORT, w.url, w.id);
    await tick(); child.onMessage.emit({ result }); await tick();
    assert.match(caller.messages[0].error, /Invalid Passkey response/);
  }
  const caller = h.caller('create'), w = h.windows.at(-1);
  const child = h.port(PASSKEY_WINDOW_PORT, w.url, w.id);
  await tick(); child.onMessage.emit({ result: { password: '09'.repeat(32), config } }); await tick();
  assert.deepEqual(caller.messages[0], { result: { password: '09'.repeat(32), config } });
});
