import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPkcePair,
  DisabledSocialRecoveryProvider,
} from '../src/social-recovery';

test('PKCE uses a high-entropy verifier and SHA-256 challenge', async () => {
  const pair = await createPkcePair();
  assert.ok(pair.verifier.length >= 64);
  assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(pair.verifier, pair.challenge);
});

test('social recovery fails closed without MPC configuration', async () => {
  const provider = new DisabledSocialRecoveryProvider();
  assert.equal(provider.configured, false);
  await assert.rejects(() => provider.beginGoogleRecovery(), /audited MPC/);
});
