import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSafeProposal, mergeSafeProposals, loadSafeWorkspace } from './safeMultisig.ts';
const base = {
  version: 1, chain_id: 97, safe_address: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20),
  value: '100000000000000000000', data: '0x', nonce: '9007199254740993', safe_tx_hash: '0x' + 'aa'.repeat(32), signatures: [],
};
const signature = (owner, sig) => ({ owner: '0x' + owner.repeat(40), signature: '0x' + sig.repeat(130) });
test('preserves uint256 amounts and nonces beyond JS safe integer', () => {
  assert.deepEqual(parseSafeProposal(JSON.stringify(base)), base);
});
test('rejects hidden delegatecall, malformed values and oversized calldata', () => {
  for (const update of [{operation: 1}, {value: '-1'}, {nonce: 1}, {value: String(2n ** 256n)}, {data: '0x1'}, {chain_id: 1.1}, {signatures: [{}]}]) {
    assert.throws(() => parseSafeProposal(JSON.stringify({...base, ...update})));
  }
  assert.throws(() => parseSafeProposal(JSON.stringify({...base, data: '0x' + '00'.repeat(65537)})));
});
test('merges repeated signature exchanges without double counting owners', () => {
  const a = {...base, signatures: [signature('2', 'a')]};
  const b = {...base, signatures: [signature('1', 'b'), signature('2', 'a')]};
  const merged = mergeSafeProposals(a, b);
  assert.equal(merged.signatures.length, 2);
  assert.equal(merged.signatures[0].owner, signature('1', 'b').owner);
});
test('never merges transactions across chains, Safes, values or hashes', () => {
  for (const update of [{chain_id: 56}, {safe_address: base.to}, {value: '5'}, {data: '0xab'}, {nonce: '1'}, {safe_tx_hash: '0x' + 'bb'.repeat(32)}]) {
    assert.throws(() => mergeSafeProposals(base, {...base, ...update}));
  }
  assert.throws(() => mergeSafeProposals({...base, signatures: [signature('1', 'a')]}, {...base, signatures: [signature('1', 'b')]}));
});
test('restores proposals with their pending broadcast hashes and chain scope', () => {
  const state = { safes: [{chainId: 97, address: base.safe_address, label: 'BNB test'}],
    proposals: [{proposal: base, transactionHash: '0x'+'cc'.repeat(32), status: 'pending'}] };
  assert.deepEqual(loadSafeWorkspace(JSON.stringify(state)), state);
  assert.throws(() => loadSafeWorkspace('{invalid'));
});

test('lists multiple Safes per creator or owner and isolates each Safe’s proposals', async () => {
  const { safesForWallet, proposalsForSafe } = await import('./safeMultisig.ts');
  const owner = '0x' + '33'.repeat(20);
  const safes = [
    {chainId: 97, address: base.safe_address, label: 'A', createdBy: owner},
    {chainId: 97, address: base.to, label: 'B', owners: [owner]},
    {chainId: 56, address: base.safe_address, label: 'Mainnet', createdBy: owner},
  ];
  assert.equal(safesForWallet(safes, 97, owner).length, 2);
  assert.equal(safesForWallet(safes, 56, owner).length, 1);
  const proposals = [{proposal: base}, {proposal: {...base, nonce: '2'}}, {proposal: {...base, safe_address: base.to}}, {proposal: {...base, chain_id: 56}}];
  assert.equal(proposalsForSafe(proposals, 97, base.safe_address).length, 2);
  assert.equal(proposalsForSafe(proposals, 97, base.to).length, 1);
});

test('queues multiple independent proposals without losing uint256 nonce precision', async () => {
  const { nextSafeNonce } = await import('./safeMultisig.ts');
  assert.equal(nextSafeNonce('0', []), '0');
  assert.equal(nextSafeNonce('2', [{proposal: {...base, nonce: '0'}}]), '2');
  assert.equal(nextSafeNonce('2', [{proposal: {...base, nonce: '2'}}, {proposal: {...base, nonce: '3'}}]), '4');
  assert.equal(nextSafeNonce('9007199254740993', [{proposal: base}]), '9007199254740994');
});

test('nonce allocation fills a gap before a future imported proposal', async () => {
  const { nextSafeNonce } = await import('./safeMultisig.ts');
  assert.equal(nextSafeNonce('0', [{proposal: {...base, nonce: '8'}}]), '0');
  assert.equal(nextSafeNonce('0', ['0', '1', '3'].map(nonce => ({proposal: {...base, nonce}}))), '2');
});

test('creation feedback rejects duplicate owners, sentinel addresses and invalid thresholds', async () => {
  const { validateSafeCreation } = await import('./safeMultisig.ts');
  const owners = `${base.safe_address}\n${base.to}`;
  assert.equal(validateSafeCreation(owners, '2'), null);
  assert.equal(validateSafeCreation(`${base.to},${base.to}`, '2'), 'duplicateOwners');
  assert.equal(validateSafeCreation(`${base.to},0x${'0'.repeat(40)}`, '2'), 'invalidOwnerAddress');
  assert.equal(validateSafeCreation(`${base.to},0x${'0'.repeat(39)}1`, '2'), 'invalidOwnerAddress');
  assert.equal(validateSafeCreation(owners, '3'), 'invalidThreshold');
  assert.equal(validateSafeCreation(owners, '1'), 'invalidThreshold');
});

test('transfer feedback covers precision, byte-aligned calldata and nonce range', async () => {
  const { validateSafeTransfer } = await import('./safeMultisig.ts');
  assert.equal(validateSafeTransfer(base.to, '0.000000000000000001', '0x', ''), null);
  assert.equal(validateSafeTransfer(base.to, '0.0000000000000000001', '0x', ''), 'invalidAmount');
  assert.equal(validateSafeTransfer(base.to, '1e3', '0x', ''), 'invalidAmount');
  assert.equal(validateSafeTransfer(base.to, '0', '0x1', ''), 'invalidCalldata');
  assert.equal(validateSafeTransfer(base.to, '0', '0x12', '-1'), 'invalidNonce');
  assert.equal(validateSafeTransfer(base.to, '0', '0x12', String(2n ** 256n)), 'invalidNonce');
});

test('transaction feedback advances queued proposals while preserving final receipt states', async () => {
  const { safeProposalState } = await import('./safeMultisig.ts');
  const account = {nonce:'0', threshold:2};
  const proposal = {...base, nonce:'0'};
  assert.equal(safeProposalState({proposal}, account), 'signing');
  assert.equal(safeProposalState({proposal:{...proposal,signatures:[signature('1','a'),signature('2','b')]}}, account), 'ready');
  assert.equal(safeProposalState({proposal:{...proposal,nonce:'1'}}, account), 'queued');
  assert.equal(safeProposalState({proposal}, {...account,nonce:'1'}), 'stale');
  assert.equal(safeProposalState({proposal,transactionHash:'0x123'}, account), 'pending');
  for (const status of ['confirmed','failed','unverified']) assert.equal(safeProposalState({proposal,status}, {...account,nonce:'1'}), status);
});

test('restores local signer labels and rejects malformed label metadata', () => {
  const safe = {chainId:97,address:base.safe_address,label:'Team',ownerLabels:{[base.to]:'Signer B'}};
  assert.equal(loadSafeWorkspace(JSON.stringify({safes:[safe],proposals:[]})).safes[0].ownerLabels[base.to], 'Signer B');
  for (const ownerLabels of [null, [], {[base.to]:42}, {[base.to]:'x'.repeat(101)}, {invalid:'Name'}]) {
    assert.throws(() => loadSafeWorkspace(JSON.stringify({safes:[{...safe,ownerLabels}],proposals:[]})));
  }
});

test('responses cannot substitute any transaction field before review/signing or after signing', async () => {
  const {assertSafeProposalMatches} = await import('./safeMultisig.ts');
  assert.doesNotThrow(()=>assertSafeProposalMatches(base,base));
  for(const update of [{chain_id:56},{safe_address:base.to},{to:base.safe_address},{value:'9'},{data:'0x00'},{nonce:'0'},{safe_tx_hash:'0x'+'ee'.repeat(32)}]) {
    assert.throws(()=>assertSafeProposalMatches({...base,...update},base));
  }
  assert.doesNotThrow(()=>assertSafeProposalMatches({...base,signatures:[signature('1','a')]},base));
});
test('owner and target address forms reject mixed-case checksum errors before RPC', async () => {
  const {validateSafeCreation,validateSafeTransfer} = await import('./safeMultisig.ts');
  const typo='0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  assert.equal(validateSafeCreation(typo+'\n'+base.to,'2'),'invalidOwnerAddress');
  assert.equal(validateSafeTransfer(typo,'0','0x',''),'invalidRecipient');
});
