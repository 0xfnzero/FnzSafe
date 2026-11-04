import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Isolated, unfunded test wallet. Only WebAuthn is mocked; Chrome windows, ports,
// background authorization, encrypted persistence and React forms are real.
const profile = await mkdtemp(resolve(tmpdir(), 'fnzsafe-import-passkey-e2e-'));
const screenshots = process.env.FNZSAFE_E2E_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>FnzSafe badge test</title>Local unfunded test DApp');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.FNZSAFE_E2E_CHROME ? { executablePath: process.env.FNZSAFE_E2E_CHROME } : { channel: 'chrome' }),
    headless: false, viewport: null, locale: 'en-US',
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
  });
  await context.route('https://**/*', route => route.abort());
  await context.addInitScript(() => {
    if (location.pathname !== '/passkey.html') return;
    const response = (options, type) => ({
      rawId: new Uint8Array(32).fill(1).buffer,
      response: { clientDataJSON: new TextEncoder().encode(JSON.stringify({
        type, origin: location.origin,
        challenge: btoa(String.fromCharCode(...options.publicKey.challenge)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
      })).buffer },
      getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(9).buffer } } }),
    });
    Object.defineProperty(navigator, 'credentials', { value: {
      create: async options => response(options, 'webauthn.create'),
      get: async options => response(options, 'webauthn.get'),
    } });
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.evaluate(async () => { const win = await chrome.windows.getCurrent(); await chrome.windows.update(win.id, { width: 400, height: 800 }); });
  await page.getByRole('button', { name: /Your wallet is ready/ }).click();
  async function helperAfter(action) {
    const popup = context.waitForEvent('page'); await action();
    const helper = await popup; await helper.waitForURL('**/passkey.html?*');
    await helper.getByRole('button', { name: 'Continue with Passkey' }).waitFor();
    const geometry = await helper.evaluate(async () => ({
      window: await chrome.windows.getCurrent(),
      screen: { left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight },
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    assert.ok(geometry.window.left >= geometry.screen.left);
    assert.ok(geometry.window.left + geometry.window.width <= geometry.screen.left + geometry.screen.width);
    assert.ok(Math.abs(geometry.window.left + geometry.window.width / 2 - (geometry.screen.left + geometry.screen.width / 2)) < 20, JSON.stringify(geometry));
    assert.equal(geometry.overflow, false);
    return helper;
  }
  async function verify(helper) {
    const closed = helper.waitForEvent('close');
    await helper.getByRole('button', { name: 'Continue with Passkey' }).click().catch(error => {
      // A mocked authenticator may finish before Playwright receives click ack.
      if (!helper.isClosed()) throw error;
    });
    await closed;
  }
  let helper = await helperAfter(() => page.getByRole('button', { name: 'Set up Passkey', exact: true }).click());
  if (screenshots) await helper.screenshot({ path: resolve(screenshots, 'passkey-window.png') });
  await verify(helper);
  await page.getByRole('button', { name: 'Switch wallet' }).click();
  await page.getByRole('button', { name: 'Import wallet', exact: true }).click();
  await page.getByLabel('Import format').selectOption('privateKey');
  await page.getByLabel('Wallet name', { exact: true }).fill('Trading wallet');
  await page.getByLabel('Private key', { exact: true }).fill('1'.padStart(64, '0'));
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'named-import.png') });
  helper = await helperAfter(() => page.getByRole('button', { name: 'Import accounts', exact: true }).click());
  await helper.close();
  await page.getByText('Passkey verification was cancelled', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Wallet name', { exact: true }).inputValue(), 'Trading wallet');
  helper = await helperAfter(() => page.getByRole('button', { name: 'Import accounts', exact: true }).click());
  await verify(helper);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const status = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }));
  assert.equal(status.ok, true);
  assert.equal(status.result.wallets.find(w => w.id === status.result.activeWalletId).name, 'Trading wallet');
  assert.equal(status.result.accounts.find(a => a.id === status.result.settings.activeAccountId).address.toLowerCase(), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  await page.getByRole('button', { name: 'Switch wallet' }).click();
  await page.getByRole('button', { name: 'Rename wallet', exact: true }).click();
  await page.getByLabel('Wallet name', { exact: true }).fill('Cancelled name');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Rename wallet', exact: true }).click();
  assert.equal(await page.getByLabel('Wallet name', { exact: true }).inputValue(), 'Trading wallet');
  await page.getByLabel('Wallet name', { exact: true }).fill('Wallet 1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'A wallet with this name already exists' }).waitFor();
  await page.getByLabel('Wallet name', { exact: true }).fill('Renamed trading wallet');
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'rename-wallet.png') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Renamed trading wallet', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dismiss panel', exact: true }).click();
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'LOCK' }));
  await page.reload();
  helper = await helperAfter(() => page.getByRole('button', { name: 'Unlock with Passkey', exact: true }).click());
  await verify(helper);
  await page.getByRole('button', { name: 'Switch wallet' }).waitFor();
  assert.match(await page.getByRole('button', { name: 'Switch wallet' }).innerText(), /Renamed trading wallet/);
  const dapp = await context.newPage();
  await dapp.goto(`http://127.0.0.1:${server.address().port}`);
  await dapp.waitForFunction(() => window.ethereum?.isFnzSafe);
  async function requestApproval(key) {
    const popup = context.waitForEvent('page');
    await dapp.evaluate(key => {
      window[key] = window.ethereum.request({ method: 'eth_requestAccounts' }).then(result => ({ result }), error => ({ code: error.code }));
    }, key);
    const approval = await popup;
    await approval.getByRole('button', { name: 'Approve', exact: true }).waitFor();
    return approval;
  }
  async function expectBadge(text) {
    await page.waitForFunction(async expected => await chrome.action.getBadgeText({}) === expected, text);
  }
  const firstApproval = await requestApproval('firstRequest');
  const secondApproval = await requestApproval('secondRequest');
  await expectBadge('2');
  await page.locator('.request-count').filter({ hasText: '2' }).waitFor();
  await page.getByRole('button', { name: 'Review', exact: true }).first().click();
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'pending-requests.png') });
  await firstApproval.getByRole('button', { name: 'Reject', exact: true }).click().catch(error => { if (!firstApproval.isClosed()) throw error; });
  assert.equal((await dapp.evaluate(() => window.firstRequest)).code, 4001);
  await expectBadge('1');
  await secondApproval.getByRole('button', { name: 'Approve', exact: true }).click().catch(error => { if (!secondApproval.isClosed()) throw error; });
  assert.equal((await dapp.evaluate(() => window.secondRequest)).result.length, 1);
  await expectBadge('');
  await page.locator('.pending-requests').waitFor({ state: 'hidden' });
  console.log('PASS: centered Passkey enrollment, cancel/retry, named private-key import, rename/cancel/duplicate validation, unlock with persisted name, and live Chrome badge 2 → 1 → empty with pending request navigation.');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
