import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import { mergeProposals, parseProposal, proposalHash, verifySignatures, type SafeProposal } from '../src/safe';
const wallets = [new Wallet('0x' + '01'.padStart(64, '0')), new Wallet('0x' + '02'.padStart(64, '0'))];
function fixture(): SafeProposal {
  const p: SafeProposal = { version: 1, chain_id: 1, safe_address: '0x' + '11'.repeat(20), to: wallets[0].address, value: '1000000000000000001', data: '0x', nonce: '0', safe_tx_hash: '', signatures: [] };
  p.safe_tx_hash = proposalHash(p); return p;
}
test('Safe proposals reject delegatecall/refund extensions, malformed uints and oversized calldata', () => {
  const p = fixture(); assert.deepEqual(parseProposal(JSON.stringify(p)), p);
  for (const patch of [{ operation: 1 }, { value: '-1' }, { nonce: '01' }, { value: (1n << 256n).toString() }, { data: '0xf' }, { signatures: null }]) assert.throws(() => parseProposal(JSON.stringify({ ...p, ...patch })));
});
test('Safe signatures bind every transaction field, reject duplicate/nonowners and merge deterministically', () => {
  const p = fixture();
  const signed = wallets.map(wallet => ({ ...p, signatures: [{ owner: wallet.address, signature: wallet.signingKey.sign(p.safe_tx_hash).serialized }] }));
  const merged = verifySignatures(mergeProposals(signed[1], signed[0]), wallets.map(w => w.address));
  assert.equal(merged.signatures.length, 2); assert.ok(merged.signatures[0].owner < merged.signatures[1].owner);
  for (const patch of [{ value: '2' }, { nonce: '1' }, { chain_id: 56 }, { data: '0x00' }, { to: wallets[1].address }]) assert.throws(() => verifySignatures({ ...merged, ...patch }, wallets.map(w => w.address)), /mismatch/);
  assert.throws(() => verifySignatures({ ...merged, signatures: [merged.signatures[0], merged.signatures[0]] }, wallets.map(w => w.address)), /duplicate/);
  assert.throws(() => verifySignatures(merged, [wallets[0].address]), /non-owner/);
  const changed = { ...p, value: '3' }; changed.safe_tx_hash = proposalHash(changed);
  assert.throws(() => mergeProposals(p, changed), /different/);
});
