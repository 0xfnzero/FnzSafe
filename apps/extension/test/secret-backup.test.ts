import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecretBackup, splitBackupSecret } from '../src/secret-backup';
import { importWallet } from '../src/import-wallet';
import { createInitialVault } from '../src/vault';

test('desktop-format encrypted mnemonic restores all derived chain addresses; wrong password fails', async () => {
  const original = createInitialVault('test test test test test test test test test test test junk');
  const password = 'separate-backup-password';
  const text = await encryptSecretBackup(original.recoveryMnemonic, password);
  assert.equal(text.includes(original.recoveryMnemonic), false);
  const restored = await importWallet({ kind: 'encrypted', text, password, family: 'evm' });
  assert.deepEqual(restored.accounts.map(a => [a.family, a.address]), original.accounts.map(a => [a.family, a.address]));
  await assert.rejects(importWallet({ kind: 'encrypted', text, password: 'incorrect-password', family: 'evm' }));
});
test('ordered fragments reassemble keys and preserve mnemonic word boundaries', () => {
  const key = '0123456789abcdef';
  assert.deepEqual(splitBackupSecret(key, 3), ['012345', '6789a', 'bcdef']);
  assert.equal(splitBackupSecret(key, 12).join(''), key);
  const phrase = 'test test test test test test test test test test test junk';
  assert.equal(splitBackupSecret(phrase, 5).join(' '), phrase);
  assert.throws(() => splitBackupSecret(key, 13));
  assert.throws(() => splitBackupSecret(key, 1.5));
});
