import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptSessionVault,
  destroyVaultSession,
  protectVaultInMemory,
} from '../src/memory-vault';
import type { VaultPayload } from '../src/types';

const payload: VaultPayload = {
  recoveryMnemonic: '',
  selectedAccountId: 'account-1',
  selectedEvmChainId: 1,
  selectedSolanaCluster: 'mainnet-beta',
  accounts: [{
    id: 'account-1',
    name: 'EVM Account',
    family: 'evm',
    address: '0x0000000000000000000000000000000000000001',
    privateKey: `0x${'11'.repeat(32)}`,
  }],
};

test('unlocked vault keeps private keys encrypted in memory', async () => {
  const session = await protectVaultInMemory(payload);
  assert.equal('privateKey' in session.accounts[0], false);
  assert.equal(
    new TextDecoder().decode(session.ciphertext).includes(payload.accounts[0].privateKey),
    false,
  );
  assert.deepEqual(await decryptSessionVault(session), payload);

  destroyVaultSession(session);
  await assert.rejects(decryptSessionVault(session));
  assert.equal(session.ciphertext.every((value) => value === 0), true);
});

test('session strips all mnemonic roots and destroys the encrypted creation authorization on lock', async () => {
  const { createInitialVault, mergeVaultAccounts } = await import('../src/vault');
  const { sessionAuthorization } = await import('../src/memory-vault');
  const grouped = mergeVaultAccounts(createInitialVault(), createInitialVault());
  const password = 'in-memory-authorization';
  const session = await protectVaultInMemory(grouped, password, true);
  assert.equal(session.key.extractable, false);
  assert.equal(JSON.stringify(session).includes(password), false);
  assert.notDeepEqual(session.iv, session.authorization!.iv);
  assert.equal(await sessionAuthorization(session), password);
  const memory = await decryptSessionVault(session);
  assert.equal(memory.recoveryMnemonic, '');
  assert.ok(memory.wallets!.every(w => w.recoveryMnemonic === ''));
  assert.ok(session.wallets.every(w => w.hasRecoveryPhrase));
  destroyVaultSession(session);
  assert.ok(session.authorization!.ciphertext.every(b => b === 0));
  await assert.rejects(sessionAuthorization(session));
});
