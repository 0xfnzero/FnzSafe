import assert from 'node:assert/strict';
import test from 'node:test';
import { grantOriginPermission, hasOriginPermission, normalizePermissionStore } from '../src/permissions';

test('legacy family-only permissions require sites to reconnect', () => {
  assert.deepEqual(normalizePermissionStore({ 'https://app.example': ['evm'] }), {});
});

test('permissions are scoped to origin, family and account', () => {
  const granted = grantOriginPermission({}, 'https://app.example', 'evm', 'evm-account-1', 1, 1000);
  assert.equal(hasOriginPermission(granted, 'https://app.example', 'evm', 'evm-account-1', 1), true);
  assert.equal(hasOriginPermission(granted, 'https://app.example', 'evm', 'evm-account-1', 8453), false);
  assert.equal(hasOriginPermission(granted, 'https://other.example', 'evm', 'evm-account-1', 1), false);
  assert.equal(hasOriginPermission(granted, 'https://app.example', 'evm', 'evm-account-2', 1), false);
  assert.equal(hasOriginPermission(granted, 'https://app.example', 'solana', 'evm-account-1', 'mainnet-beta'), false);
  assert.deepEqual(granted['https://app.example'].evmChainIds, [1]);
});

test('granting another network preserves the existing account permission', () => {
  const first = grantOriginPermission({}, 'https://app.example', 'evm', 'evm-account-1', 1, 1000);
  const second = grantOriginPermission(first, 'https://app.example', 'evm', 'evm-account-1', 8453, 2000);
  assert.deepEqual(second['https://app.example'].evmChainIds, [1, 8453]);
  assert.equal(hasOriginPermission(second, 'https://app.example', 'evm', 'evm-account-1', 1), true);
  assert.equal(hasOriginPermission(second, 'https://app.example', 'evm', 'evm-account-1', 8453), true);
  assert.equal(second['https://app.example'].grantedAt, 1000);
});
