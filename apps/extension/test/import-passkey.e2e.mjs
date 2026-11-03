import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Isolated, unfunded test wallet. Only WebAuthn is mocked; Chrome windows, ports,
// background authorization, encrypted persistence and React forms are real.
const profile = await mkdtemp(resolve(tmpdir(), 'fnzsafe-import-passkey-e2e-'));
const screenshots = process.env.FNZSAFE_E2E_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
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
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'LOCK' }));
  await page.reload();
  helper = await helperAfter(() => page.getByRole('button', { name: 'Unlock with Passkey', exact: true }).click());
  await verify(helper);
  await page.getByRole('button', { name: 'Switch wallet' }).waitFor();
  assert.match(await page.getByRole('button', { name: 'Switch wallet' }).innerText(), /Trading wallet/);
  console.log('PASS: centered Passkey enrollment, cancel/retry, named private-key import, and unlock with persisted name.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
