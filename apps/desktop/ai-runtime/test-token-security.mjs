import assert from 'node:assert/strict';
import test from 'node:test';
import { dexSecurityHandlers } from './plugins/providers/dex-security.mjs';
import { web3MarketTools } from './plugins/web3-market-definitions.mjs';
import { validateToolArguments } from './plugins/lib/web3-utils.mjs';

const address = '0x4200000000000000000000000000000000000006';
const otherAddress = '0x1111111111111111111111111111111111111111';
const args = { network: '8453', address, secondSignal: 'greyridge-preview' };
const scan = async input => JSON.parse((await dexSecurityHandlers.token_security_scan(input)).content[0].text);
const schema = web3MarketTools.find(tool => tool.name === 'token_security_scan').inputSchema;

function fixtures() {
  const common = { token: address, analyzed_at: new Date().toISOString(), risk_score: 0 };
  return {
    gate: { ...common, side: 'buy', notional_usd: 100, decision: 'go', verdict: 'SAFE', sellability_unverified: false },
    report: { ...common, chain: 'base', verdict: 'SAFE', security: {
      simStatus: 'tested', sellabilityUnverified: false, isHoneypot: false, sellable: true,
      buyTaxBps: 0, sellTaxBps: 0, transferTaxBps: 0,
      taxMutable: false, upgradeableProxy: false, canMint: false, canPause: false, hasBlacklist: false,
    } },
  };
}

function mockProvider(context, { gate, report } = fixtures(), status = 200) {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    calls.push(target);
    assert.equal(options.method, undefined); // read-only GET, no payment or signing
    assert.equal(options.body, undefined);
    if (target.hostname === 'api.gopluslabs.io') {
      return Response.json({ result: { [address]: { is_honeypot: '1', sell_tax: '1' } } });
    }
    assert.equal(options.redirect, 'error');
    assert.equal(target.hostname, 'x402-data-api.sigrunner.workers.dev');
    assert.equal(target.searchParams.get('token'), address);
    assert.ok(['/gate/swap/preview', '/chain/token-report/preview'].includes(target.pathname));
    return Response.json(target.pathname === '/gate/swap/preview' ? gate : report, { status });
  });
  return calls;
}

test('second signal is opt-in and cannot query a different chain', async context => {
  const calls = mockProvider(context);
  assert.equal((await scan({ network: '8453', address })).secondSignal, undefined);
  assert.equal(calls.length, 1);
  for (const network of ['1', 'solana']) {
    await assert.rejects(scan({ ...args, network, address: network === 'solana' ? '1'.repeat(32) : address }), /only available for Base/);
  }
  assert.equal(calls.length, 1);
  assert.throws(() => validateToolArguments(schema, { ...args, secondSignal: 'paid' }), /must be one of/);
});

test('Base preview preserves primary warnings and drops promotional instructions', async context => {
  const data = fixtures();
  data.gate.upgrade = { pay_with: 'send money', paid_url: 'https://example.invalid' };
  data.report.badge = { html: '<script>bad</script>' };
  mockProvider(context, data);
  const result = await scan(args);
  assert.equal(result.security.isHoneypot, '1');
  assert.equal(result.secondSignal.advisory, 'go');
  assert.equal(result.secondSignal.simulationVerified, true);
  assert.equal(result.secondSignal.scenario.illustrativeOnly, true);
  assert.doesNotMatch(JSON.stringify(result), /pay_with|paid_url|<script>/);
  assert.match(result.limitation, /never overrides primary warnings/);
});

for (const [name, mutate, advisory] of [
  ['unknown taxes', d => { d.report.security.buyTaxBps = null; }, 'hold'],
  ['nonzero tax despite a zero risk score', d => { d.report.security.sellTaxBps = 10_000; }, 'hold'],
  ['unverified simulation', d => { d.report.security.simStatus = 'unavailable'; }, 'hold'],
  ['missing simulation', d => { delete d.report.security.sellabilityUnverified; }, 'hold'],
  ['mint authority', d => { d.report.security.canMint = true; }, 'hold'],
  ['positive risk score', d => { d.gate.risk_score = 12; }, 'hold'],
  ['cannot sell', d => { d.report.security.sellable = false; }, 'block'],
  ['conflicting verdicts', d => { d.report.verdict = 'AVOID'; }, 'block'],
  ['contradictory gate verdict', d => { d.gate.verdict = 'AVOID'; }, 'block'],
]) {
  test(`${name} cannot produce a positive advisory`, async context => {
    const data = fixtures(); mutate(data); mockProvider(context, data);
    const result = (await scan(args)).secondSignal;
    assert.equal(result.status, 'available'); assert.equal(result.advisory, advisory);
    if (name === 'unknown taxes') assert.equal(result.security.buyTaxBps, null);
  });
}

for (const [name, mutate] of [
  ['different token', d => { d.report.token = otherAddress; }],
  ['wrong chain', d => { d.report.chain = 'ethereum'; }],
  ['wrong chain ID', d => { d.gate.chainId = 1; }],
  ['wrong scenario', d => { d.gate.side = 'sell'; }],
  ['stale timestamp', d => { d.gate.analyzed_at = '2020-01-01T00:00:00Z'; }],
  ['future timestamp', d => { d.report.analyzed_at = '2100-01-01T00:00:00Z'; }],
  ['missing timestamp', d => { delete d.report.analyzed_at; }],
  ['invalid score', d => { d.gate.risk_score = '0'; }],
  ['missing report', d => { d.report = {}; }],
]) {
  test(`${name} is unavailable, never a successful check`, async context => {
    const data = fixtures(); mutate(data); mockProvider(context, data);
    const result = await scan(args);
    assert.equal(result.secondSignal.status, 'unavailable');
    assert.equal(result.secondSignal.advisory, 'hold');
    assert.equal(result.security.isHoneypot, '1');
  });
}

for (const status of [402, 403, 429, 500]) {
  test(`HTTP ${status} retains primary evidence and makes no paid retry`, async context => {
    const calls = mockProvider(context, fixtures(), status);
    const result = await scan(args);
    assert.equal(result.secondSignal.status, 'unavailable');
    assert.equal(result.security.isHoneypot, '1');
    assert.equal(calls.length, 3);
  });
}

test('network failure retains primary evidence', async context => {
  context.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('gopluslabs.io')) return Response.json({ result: { [address]: { is_honeypot: '1' } } });
    throw new DOMException('Aborted', 'AbortError');
  });
  const result = await scan(args);
  assert.equal(result.secondSignal.status, 'unavailable');
  assert.equal(result.security.isHoneypot, '1');
});

test('GoPlus never substitutes another token for a missing exact record', async context => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ result: { [otherAddress]: { is_honeypot: '0' } } }));
  assert.equal((await scan({ network: '8453', address })).security, null);
});
