import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretClipboard } from '../src/secret-clipboard';

test('expiry clears a copied secret, but preserves newer user clipboard content', async () => {
  let value = 'previous';
  const clipboard = new SecretClipboard({ async readText() { return value; }, async writeText(next) { value = next; } }, () => assert.fail('cleanup failed'), 10);
  await clipboard.copy('fixture-secret');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(value, '');
  await clipboard.copy('fixture-secret'); value = 'new user text';
  await new Promise(r => setTimeout(r, 30));
  assert.equal(value, 'new user text');
});
test('lock/hidden cleanup and concurrent copies are serialized; clipboard permission failure prevents copying', async () => {
  let value = '', readable = true;
  const clipboard = new SecretClipboard({ async readText() { if (!readable) throw new Error('Permission denied'); return value; }, async writeText(next) { value = next; } });
  await Promise.all([clipboard.copy('first'), clipboard.clear(), clipboard.copy('second')]);
  assert.equal(value, 'second'); await clipboard.clear(); assert.equal(value, '');
  readable = false;
  await assert.rejects(clipboard.copy('must-not-copy'), /Permission denied/);
  assert.equal(value, '');
});
test('a failed clear reports failure and a retry preserves a newer clipboard value', async () => {
  let value = '', readable = true;
  const clipboard = new SecretClipboard({ async readText() { if (!readable) throw new Error('Temporary failure'); return value; }, async writeText(next) { value = next; } });
  await clipboard.copy('fixture-secret'); readable = false;
  await assert.rejects(clipboard.clear(), /Temporary failure/);
  readable = true; value = 'new user text';
  await clipboard.clear(); assert.equal(value, 'new user text');
});
