import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(resolve(tmpdir(), 'fnzsafe-arc-e2e-'));
const extensionPath = resolve('dist');
const screenshotDirectory = process.env.FNZSAFE_E2E_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Arc provider test</title><main>Arc</main>');
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.FNZSAFE_E2E_CHROME ? { executablePath: process.env.FNZSAFE_E2E_CHROME } : { channel: 'chrome' }),
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByLabel('Wallet password').fill('arc-test-only-password');
  await popup.getByLabel('Confirm password').fill('arc-test-only-password');
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await popup.getByRole('button', { name: 'I saved it offline' }).click();
  await popup.getByText('EVM Account 1').waitFor();
  const dapp = await context.newPage();
  await dapp.goto(`http://127.0.0.1:${server.address().port}`);

  async function approveRequest(method, params, expectedText) {
    const nextPage = context.waitForEvent('page');
    await dapp.evaluate(({ method, params }) => {
      window.arcRequest = window.ethereum.request({ method, params });
    }, { method, params });
    const approval = await nextPage;
    await approval.getByText(expectedText, { exact: true }).waitFor();
    await approval.getByRole('button', { name: 'Approve' }).click();
    return dapp.evaluate(() => window.arcRequest);
  }

  const accounts = await approveRequest('eth_requestAccounts', [], 'Allow this site to connect to FnzSafe?');
  assert.equal(accounts.length, 1);
  for (const [hex, name] of [['0x13b2', 'Arc'], ['0x4cef52', 'Arc Testnet']]) {
    const id = Number.parseInt(hex, 16);
    const metadata = [{ chainId: hex, rpcUrls: ['https://untrusted.example.invalid'], nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 } }];
    assert.equal(await approveRequest('wallet_addEthereumChain', metadata, `${name} (${id})`), null);
    assert.equal(await approveRequest('wallet_switchEthereumChain', [{ chainId: hex }], `${name} (${id})`), null);
    assert.equal(await dapp.evaluate(() => window.ethereum.request({ method: 'eth_chainId' })), hex);
    await popup.reload();
    await popup.getByLabel('Network').selectOption(`evm:${id}`);
    await popup.locator('.asset-row').filter({ hasText: 'USDC' }).waitFor({ timeout: 30_000 });
    assert.equal(await popup.locator('.asset-row').filter({ hasText: 'USDC' }).count(), 1);
    assert.equal(await popup.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
    assert.equal(await popup.locator('img[src="chain-icons/arc.svg"]').evaluate((image) => image.complete && image.naturalWidth > 0), true);
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await popup.setViewportSize({ width, height });
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      if (screenshotDirectory) await popup.screenshot({ path: resolve(screenshotDirectory, `arc-${id}-${width}.png`), fullPage: true });
    }
  }
  console.log(JSON.stringify({ arcMainnet: true, arcTestnet: true, dappAddAndSwitch: true, singleUsdcBalance: true, icons: true, viewports: [1280, 390], transactionsBroadcast: 0 }));
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
