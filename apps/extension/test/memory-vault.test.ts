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
