import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(resolve(tmpdir(), 'fnzsafe-extension-e2e-'));
const extensionPath = resolve('dist');
const chromePath = process.env.FNZSAFE_E2E_CHROME;
const screenshotDirectory = process.env.FNZSAFE_E2E_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>FnzSafe provider test</title><main>Provider test</main>');
});

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not start');

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  assert.ok(extensionId);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByLabel('Wallet password').fill('test-only-password');
  await popup.getByLabel('Confirm password').fill('test-only-password');
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await popup.getByRole('heading', { name: 'Back up your wallet' }).waitFor();
  assert.equal(await popup.locator('.recovery-grid span').count(), 12);
  await popup.getByRole('button', { name: 'I saved it offline' }).click();
  await popup.getByText('EVM Account 1').waitFor();
  await popup.locator('.asset-row').filter({ hasText: 'ETH' }).waitFor({ timeout: 30_000 });
  if (screenshotDirectory) {
    await popup.screenshot({
      path: resolve(screenshotDirectory, 'fnzsafe-extension-evm.png'),
      fullPage: true,
    });
  }

  await popup.getByLabel('Chain').selectOption('bitcoin');
  await popup.getByText('Bitcoin Account 1').waitFor();
  await popup.locator('.asset-row').filter({ hasText: 'BTC' }).waitFor();
  if (screenshotDirectory) {
    await popup.screenshot({
      path: resolve(screenshotDirectory, 'fnzsafe-extension-bitcoin.png'),
      fullPage: true,
    });
  }
  assert.match(await popup.locator('.address').innerText(), /^bc1/);
  assert.equal(await popup.getByRole('button', { name: 'Send' }).isDisabled(), true);

  await popup.getByTitle('Lock wallet').click();
  await popup.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await popup.getByLabel('Wallet password').fill('definitely-wrong');
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await popup.getByText(/Incorrect password/).waitFor();
  await popup.getByLabel('Wallet password').fill('test-only-password');
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await popup.getByText('EVM Account 1').waitFor();

  const dapp = await context.newPage();
  await dapp.goto(`http://127.0.0.1:${address.port}`);
  const discovery = await dapp.evaluate(async () => {
    const providers = [];
    const standardWallets = [];
    window.addEventListener('eip6963:announceProvider', (event) => {
      providers.push(event.detail.info.name);
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
      detail: {
        register(wallet) {
          standardWallets.push(wallet.name);
        },
      },
    }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    return {
      injected: window.ethereum?.isFnzSafe === true,
      providers,
      standardWallets,
      chainId: await window.ethereum?.request({ method: 'eth_chainId' }),
    };
  });
  assert.deepEqual(discovery, {
    injected: true,
    providers: ['FnzSafe'],
    standardWallets: ['FnzSafe'],
    chainId: '0x1',
  });

  await dapp.evaluate(() => {
    window.fnzsafeConnect = window.ethereum.request({ method: 'eth_requestAccounts' });
  });
  const approval = await context.waitForEvent('page');
  await approval.getByText('Allow this site to connect to FnzSafe?').waitFor();
  await approval.getByRole('button', { name: 'Approve' }).click();
  const accounts = await dapp.evaluate(() => window.fnzsafeConnect);
  assert.equal(accounts.length, 1);
  assert.match(accounts[0], /^0x[0-9a-fA-F]{40}$/);

  const invalidApprovalPromise = context.waitForEvent('page');
  await dapp.evaluate((from) => {
    window.fnzsafeInvalidTransaction = window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: from, value: '0x0', chainId: '0x89' }],
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, code: error.code, message: error.message }),
    );
  }, accounts[0]);
  const invalidApproval = await invalidApprovalPromise;
  await invalidApproval.getByText(/does not match selected chain/).waitFor();
  await invalidApproval.close();
  const invalidTransaction = await dapp.evaluate(() => window.fnzsafeInvalidTransaction);
  assert.equal(invalidTransaction.ok, false);
  assert.equal(invalidTransaction.code, 4001);

  await popup.getByRole('button', { name: 'Settings' }).click();
  await popup.getByText('On by default - public addresses may be sent to configured index services').waitFor();
  await popup.getByText('1 authorized', { exact: true }).waitFor();
  await popup.getByRole('button', { name: 'Disconnect 127.0.0.1' }).click();
  await popup.getByText('No sites currently authorized').waitFor();

  const uniswap = await context.newPage();
  await uniswap.goto('https://app.uniswap.org', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  const uniswapDiscovery = await uniswap.evaluate(async () => {
    const providers = [];
    window.addEventListener('eip6963:announceProvider', (event) => {
      providers.push(event.detail.info.name);
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    return providers;
  });
  assert.ok(uniswapDiscovery.includes('FnzSafe'));

  console.log(JSON.stringify({
    extensionId,
    chains: ['evm', 'solana', 'bitcoin', 'tron'],
    providerDiscovery: discovery,
    uniswapDiscovery,
  }));
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
