import test from 'node:test';
import assert from 'node:assert/strict';
import { lamportsAsSol, canConfirmProgramClose } from './programClose.ts';

test('SOL formatting preserves every lamport and supports negative net recovery', () => {
  assert.equal(lamportsAsSol('0'), '0.000000000');
  assert.equal(lamportsAsSol('1'), '0.000000001');
  assert.equal(lamportsAsSol('2039280'), '0.002039280');
  assert.equal(lamportsAsSol('18446744073709551615'), '18446744073.709551615');
  assert.equal(lamportsAsSol('-5000'), '-0.000005000');
});

test('closing requires a preview for the exact wallet and program plus both confirmations', () => {
  const p = { wallet_id: 'wallet', program_id: 'program' };
  assert.equal(canConfirmProgramClose(p, 'wallet', 'program', 'program', true), true);
  for (const args of [
    [null, 'wallet', 'program', 'program', true],
    [p, 'other', 'program', 'program', true],
    [p, 'wallet', 'other', 'program', true],
    [p, 'wallet', 'program', 'pro', true],
    [p, 'wallet', 'program', 'program ', true],
    [p, 'wallet', 'program', 'program', false],
  ]) assert.equal(canConfirmProgramClose(...args), false);
});
