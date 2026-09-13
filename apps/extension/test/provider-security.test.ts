import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApprovalRequestGuard,
  safeProviderOrigin,
  validateProviderRequest,
} from '../src/provider-security';

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    channel: 'fnzsafe:provider',
    family: 'evm',
    method: 'eth_requestAccounts',
    params: [],
    ...overrides,
  };
}

test('provider origins allow HTTPS and local HTTP only', () => {
  assert.equal(safeProviderOrigin('https://app.uniswap.org/swap'), 'https://app.uniswap.org');
  assert.equal(safeProviderOrigin('http://localhost:3000/test'), 'http://localhost:3000');
  assert.equal(safeProviderOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(safeProviderOrigin('http://evil.example'), null);
  assert.equal(safeProviderOrigin('file:///tmp/dapp.html'), null);
});

test('provider requests enforce family methods and payload bounds', () => {
  assert.equal(validateProviderRequest(request()).family, 'evm');
  assert.throws(() => validateProviderRequest(request({ family: 'solana' })), /Unsupported provider method/);
  assert.throws(() => validateProviderRequest(request({ method: 'solana_connect' })), /Unsupported provider method/);
  assert.throws(() => validateProviderRequest(request({ params: ['x'.repeat(70 * 1024)] })), /too large/);
  assert.throws(() => validateProviderRequest(request({ id: '../approval' })), /Invalid provider request/);
});

test('approval guard rejects duplicates and bounds pending requests per origin', () => {
  const guard = new ApprovalRequestGuard();
  const pending = new Map([
    ['one', { origin: 'https://app.example' }],
    ['two', { origin: 'https://app.example' }],
    ['three', { origin: 'https://app.example' }],
  ]);
  assert.throws(() => guard.assertAllowed('one', 'https://app.example', pending), /already pending/);
  assert.throws(() => guard.assertAllowed('four', 'https://app.example', pending), /too many pending/);
  assert.doesNotThrow(() => guard.assertAllowed('four', 'https://other.example', pending));
});

test('approval guard rate limits popup spam', () => {
  const guard = new ApprovalRequestGuard();
  const pending = new Map<string, { origin: string }>();
  for (let index = 0; index < 10; index += 1) {
    guard.assertAllowed(String(index), 'https://app.example', pending, 10_000 + index);
  }
  assert.throws(
    () => guard.assertAllowed('last', 'https://app.example', pending, 20_000),
    /too quickly/,
  );
});
