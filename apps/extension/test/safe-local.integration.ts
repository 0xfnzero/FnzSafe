/** Optional local-only integration: ANVIL_BIN and SAFE_ARTIFACTS_DIR are required. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Wallet } from 'ethers';
import { evmChain } from '../src/chains';
import { evmProvider, validateRpc } from '../src/rpc';
import { prepareTransaction, sendPrepared, tokenAsset, transferRequest } from '../src/evm-transfers';
import { SAFE_FACTORY, SAFE_SINGLETON, prepareSafeCreation, safeAccount, propose, signProposal, prepareSafeExecution, safeReceipt, validateProposal, safeBatchPayload } from '../src/safe';
import { discoverSafes } from '../src/safe-discovery';
const artifacts = process.env.SAFE_ARTIFACTS_DIR;
const binary = process.env.ANVIL_BIN;
if (!artifacts || !binary) throw new Error('Set SAFE_ARTIFACTS_DIR to Safe 1.4.1 artifacts/contracts and ANVIL_BIN to Anvil');
const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
const port = (reserve.address() as { port: number }).port; await new Promise<void>(r => reserve.close(() => r()));
const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
const exited = new Promise(r => { child.once('exit', r); child.once('error', r); });
const url = `http://127.0.0.1:${port}`;
const chain = { ...evmChain(1), rpcUrl: url };
const owner = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk');
const other = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/1");
const guard = async () => {};
async function mined(hash: string) {
  for (let i = 0; i < 100; i++) { const receipt = await provider!.getTransactionReceipt(hash); if (receipt) { assert.equal(receipt.status, 1); return; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Local transaction did not mine');
}
let provider: JsonRpcProvider | undefined;
try {
  for (let i = 0; i < 100; i++) { try { await validateRpc(chain); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  provider = await evmProvider(chain);
  const factory = JSON.parse(await readFile(join(artifacts, 'proxies/SafeProxyFactory.sol/SafeProxyFactory.json'), 'utf8'));
  const singleton = JSON.parse(await readFile(join(artifacts, 'Safe.sol/Safe.json'), 'utf8'));
  await provider.send('anvil_setCode', [SAFE_FACTORY, factory.deployedBytecode]);
  await provider.send('anvil_setCode', [SAFE_SINGLETON, singleton.deployedBytecode]);
  const multisend = JSON.parse(await readFile(join(artifacts, 'libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json'), 'utf8'));
  await provider.send('anvil_setCode',['0x9641d764fc13c8b624c04430c7356c1c7c8102e2',multisend.deployedBytecode]);
  const created = await prepareSafeCreation(provider, chain, owner.address, [owner.address, other.address], 2, '1001');
  const creationHash = await sendPrepared(provider, new Wallet(owner.privateKey), created.transaction, guard);
  await mined(creationHash);
  assert.equal(await safeReceipt(provider, creationHash, created.address), 'confirmed');
  assert.equal((await safeAccount(provider, chain, created.address)).threshold, 2);
  for (const signer of [owner.address,other.address,'0x1111111111111111111111111111111111111111']) {
    const found = await discoverSafes(provider,chain,signer,{offset:0});
    assert.equal(found.complete,true);
    assert.equal(found.accounts.length,signer.startsWith('0x1111')?0:1);
    if(found.accounts.length)assert.equal(found.accounts[0].address,created.address);
  }
  await assert.rejects(discoverSafes(provider,{...chain,chainId:97},owner.address,{offset:0}),/network/);
  const fund = await owner.connect(provider).sendTransaction({ to: created.address, value: 10n ** 18n }); await mined(fund.hash);
  let proposal = await propose(provider, chain, created.address, other.address, '1000000000000000', '0x');
  proposal = await signProposal(provider, chain, proposal, new Wallet(owner.privateKey), guard);
  await assert.rejects(prepareSafeExecution(provider, chain, owner.address, proposal), /threshold/);
  proposal = await signProposal(provider, chain, proposal, new Wallet(other.privateKey), guard);
  await assert.rejects(validateProposal(provider, chain, { ...proposal, value: '5' }), /mismatch/);
  const execution = await prepareSafeExecution(provider, chain, owner.address, proposal);
  const hash = await sendPrepared(provider, new Wallet(owner.privateKey), execution, guard); await mined(hash);
  assert.equal(await safeReceipt(provider, hash, created.address, proposal.safe_tx_hash), 'confirmed');
  assert.equal((await safeAccount(provider, chain, created.address)).nonce, '1');
  await assert.rejects(prepareSafeExecution(provider, chain, owner.address, proposal), /consumed/);
  const calls=[{to:other.address,value:'11',data:'0x'},{to:other.address,value:'13',data:'0x'}];
  const payload=safeBatchPayload(calls);
  let batch=await propose(provider,chain,created.address,payload.to,payload.value,payload.data,'1',calls);
  batch=await signProposal(provider,chain,batch,new Wallet(owner.privateKey),guard);
  batch=await signProposal(provider,chain,batch,new Wallet(other.privateKey),guard);
  await assert.rejects(validateProposal(provider,chain,{...batch,batch:[{...calls[0],value:'12'},calls[1]]}));
  const beforeBalance=BigInt(await provider.send('eth_getBalance',[other.address,'latest']));
  const batchExec=await prepareSafeExecution(provider,chain,owner.address,batch);
  const batchHash=await sendPrepared(provider,new Wallet(owner.privateKey),batchExec,guard);await mined(batchHash);
  assert.equal(await safeReceipt(provider,batchHash,created.address,batch.safe_tx_hash),'confirmed');
  assert.equal(BigInt(await provider.send('eth_getBalance',[other.address,'latest']))-beforeBalance,24n);
  const tokenFixture = JSON.parse(await readFile(new URL('./fixtures/TestToken.json', import.meta.url), 'utf8'));
  const token = await new ContractFactory(tokenFixture.abi, tokenFixture.bytecode, owner.connect(provider)).deploy(owner.address); await mined(token.deploymentTransaction()!.hash);
  const asset = await tokenAsset(provider, chain, owner.address, await token.getAddress());
  assert.equal(asset.balance, '1000.0'); assert.equal(asset.decimals, 6);
  const transfer = await prepareTransaction(provider, chain, owner.address, transferRequest(other.address, '1.234567', asset), true);
  const transferHash = await sendPrepared(provider, new Wallet(owner.privateKey), transfer, guard); await mined(transferHash);
  assert.equal((await tokenAsset(provider, chain, other.address, await token.getAddress())).rawBalance, '1234567');
  await assert.rejects(sendPrepared(provider, new Wallet(owner.privateKey), transfer, guard), /nonce changed/);
  // Forged deployment cannot be imported as a Safe.
  await provider.send('anvil_setCode', [created.address, '0x60006000']);
  await assert.rejects(safeAccount(provider, chain, created.address), /code mismatch/);
  console.log('Local EVM integration passed: Safe create, 2-of-2 sign/execute/receipt, stale nonce, code tampering, ERC-20 discovery/transfer and replay rejection.');
} finally { provider?.destroy(); child.kill('SIGTERM'); await exited; }
