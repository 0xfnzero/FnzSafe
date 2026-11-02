import { Contract, getAddress, getBytes, Interface, JsonRpcProvider, keccak256, recoverAddress, Signature, TypedDataEncoder, Wallet, ZeroAddress } from 'ethers';
import type { ChainInfo } from './types';
import { prepareTransaction, type PreparedTransaction } from './evm-transfers';

export const SAFE_FACTORY = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67';
export const SAFE_SINGLETON = '0x41675c099f32341bf84bfc5382af534df5c7461a';
const FACTORY_HASH = '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317';
const PROXY_HASH = '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c';
const SAFE_HASH = '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4';
const L2_HASH = '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff';
const abi = new Interface([
  'function masterCopy() view returns(address)', 'function VERSION() view returns(string)', 'function getOwners() view returns(address[])', 'function getThreshold() view returns(uint256)', 'function nonce() view returns(uint256)',
  'function setup(address[],uint256,address,bytes,address,address,uint256,address)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
  'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns(bool)',
  'event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)', 'event ExecutionFailure(bytes32 indexed txHash,uint256 payment)',
]);
const factoryAbi = new Interface(['function createProxyWithNonce(address,bytes,uint256) returns(address)', 'event ProxyCreation(address indexed proxy,address singleton)']);
export interface SafeProposal { version: 1; chain_id: number; safe_address: string; to: string; value: string; data: string; nonce: string; safe_tx_hash: string; signatures: Array<{ owner: string; signature: string }> }
export interface SafeAccount { address: string; chain_id: number; version: string; owners: string[]; threshold: number; nonce: string; balance_wei: string }
const safeTypes = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
] };
const uint = (v: unknown): v is string => typeof v === 'string' && v.length <= 78 && /^(0|[1-9]\d*)$/.test(v) && BigInt(v) < 1n << 256n;
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[a-f\d]{40}$/i.test(v);
export function parseProposal(raw: string): SafeProposal {
  if (raw.length > 180000) throw new Error('Proposal exceeds size limit');
  const p = JSON.parse(raw) as SafeProposal;
  const fields = ['version', 'chain_id', 'safe_address', 'to', 'value', 'data', 'nonce', 'safe_tx_hash', 'signatures'];
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !fields.includes(k)) || p.version !== 1 || !Number.isSafeInteger(p.chain_id) || p.chain_id <= 0 ||
    !address(p.safe_address) || !address(p.to) || !uint(p.value) || !uint(p.nonce) || typeof p.data !== 'string' || p.data.length > 131074 || !/^0x([a-f\d]{2})*$/i.test(p.data) ||
    typeof p.safe_tx_hash !== 'string' || !/^0x[a-f\d]{64}$/i.test(p.safe_tx_hash) || !Array.isArray(p.signatures) || p.signatures.length > 50 ||
    p.signatures.some(s => !s || Object.keys(s).some(k => k !== 'owner' && k !== 'signature') || !address(s.owner) || typeof s.signature !== 'string' || !/^0x[a-f\d]{130}$/i.test(s.signature))) throw new Error('Invalid Safe proposal format');
  if (p.to.toLowerCase() === ZeroAddress || p.safe_address.toLowerCase() === ZeroAddress) throw new Error('Zero address is not allowed');
  return p;
}
function txFields(p: SafeProposal) {
  return { to: p.to, value: p.value, data: p.data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: p.nonce };
}
export function proposalHash(p: SafeProposal): string {
  return TypedDataEncoder.hash({ chainId: p.chain_id, verifyingContract: p.safe_address }, safeTypes, txFields(p));
}
function txArgs(p: SafeProposal): unknown[] { return [p.to, p.value, p.data, 0, 0, 0, 0, ZeroAddress, ZeroAddress]; }
async function requireCode(provider: JsonRpcProvider, address: string, hashes: string[]) {
  if (!hashes.includes(keccak256(await provider.getCode(address)))) throw new Error('Verified Safe 1.4.1 deployment unavailable: contract code mismatch');
}
export async function safeAccount(provider: JsonRpcProvider, chain: ChainInfo, input: string): Promise<SafeAccount> {
  if (BigInt(await provider.send('eth_chainId', [])) !== BigInt(chain.chainId!)) throw new Error('Wrong Safe network');
  const address = getAddress(input);
  await requireCode(provider, SAFE_FACTORY, [FACTORY_HASH]);
  await requireCode(provider, address, [PROXY_HASH]);
  const safe = new Contract(address, abi, provider);
  await requireCode(provider, await safe.masterCopy(), [SAFE_HASH, L2_HASH]);
  const [version, owners, threshold, nonce, balance] = await Promise.all([safe.VERSION(), safe.getOwners(), safe.getThreshold(), safe.nonce(), provider.getBalance(address)]);
  if (version !== '1.4.1' || owners.length < 1 || owners.length > 50 || threshold < 1n || threshold > BigInt(owners.length)) throw new Error('Invalid Safe account');
  return { address, chain_id: chain.chainId!, version, owners: [...owners].map(o => getAddress(o)), threshold: Number(threshold), nonce: nonce.toString(), balance_wei: balance.toString() };
}
export function verifySignatures(p: SafeProposal, owners: string[]): SafeProposal {
  if (proposalHash(p).toLowerCase() !== p.safe_tx_hash.toLowerCase()) throw new Error('Safe transaction hash mismatch');
  const seen = new Set<string>();
  const signatures = p.signatures.map(entry => {
    const bytes = getBytes(entry.signature);
    if (bytes.length !== 65 || ![27, 28].includes(bytes[64])) throw new Error('Only EIP-712 EOA signatures are supported');
    const signature = Signature.from(entry.signature); // also enforces canonical low-s
    const owner = getAddress(entry.owner).toLowerCase();
    if (recoverAddress(p.safe_tx_hash, signature).toLowerCase() !== owner || !owners.some(o => o.toLowerCase() === owner) || seen.has(owner)) throw new Error('Invalid, duplicate or non-owner Safe signature');
    seen.add(owner); return { owner, signature: signature.serialized };
  }).sort((a, b) => a.owner.localeCompare(b.owner));
  return { ...p, signatures };
}
export async function validateProposal(provider: JsonRpcProvider, chain: ChainInfo, raw: SafeProposal): Promise<{ proposal: SafeProposal; account: SafeAccount }> {
  const p = parseProposal(JSON.stringify(raw));
  if (p.chain_id !== chain.chainId) throw new Error('Proposal is for another network');
  const account = await safeAccount(provider, chain, p.safe_address);
  if (BigInt(p.nonce) < BigInt(account.nonce)) throw new Error('Safe nonce already consumed');
  const onchain = await new Contract(p.safe_address, abi, provider).getTransactionHash(...txArgs(p), p.nonce);
  if (onchain.toLowerCase() !== proposalHash(p).toLowerCase()) throw new Error('On-chain Safe hash mismatch');
  const proposal = verifySignatures(p, account.owners);
  for (const signature of proposal.signatures) if (await provider.getCode(signature.owner) !== '0x') throw new Error('Contract owner signatures are not supported');
  return { proposal, account };
}
export async function propose(provider: JsonRpcProvider, chain: ChainInfo, safe: string, to: string, value: string, data: string, nonce?: string): Promise<SafeProposal> {
  const account = await safeAccount(provider, chain, safe);
  const p: SafeProposal = { version: 1, chain_id: chain.chainId!, safe_address: account.address, to: getAddress(to), value, data, nonce: nonce || account.nonce, safe_tx_hash: '0x' + '00'.repeat(32), signatures: [] };
  parseProposal(JSON.stringify(p));
  p.safe_tx_hash = proposalHash(p);
  return (await validateProposal(provider, chain, p)).proposal;
}
export async function signProposal(provider: JsonRpcProvider, chain: ChainInfo, raw: SafeProposal, wallet: Wallet, assertContext: () => Promise<void>): Promise<SafeProposal> {
  const { proposal, account } = await validateProposal(provider, chain, raw);
  if (!account.owners.some(o => o.toLowerCase() === wallet.address.toLowerCase()) || await provider.getCode(wallet.address) !== '0x') throw new Error('Selected account is not an EOA owner');
  if (proposal.signatures.some(s => s.owner === wallet.address.toLowerCase())) throw new Error('This owner already signed');
  await assertContext();
  proposal.signatures.push({ owner: wallet.address, signature: wallet.signingKey.sign(proposal.safe_tx_hash).serialized });
  return verifySignatures(proposal, account.owners);
}
export function mergeProposals(a: SafeProposal, b: SafeProposal): SafeProposal {
  parseProposal(JSON.stringify(a)); parseProposal(JSON.stringify(b));
  if (proposalHash(a) !== proposalHash(b) || a.safe_tx_hash.toLowerCase() !== b.safe_tx_hash.toLowerCase()) throw new Error('Cannot merge different Safe proposals');
  const signatures = new Map(a.signatures.map(s => [s.owner.toLowerCase(), s]));
  for (const s of b.signatures) {
    const previous = signatures.get(s.owner.toLowerCase());
    if (previous && previous.signature.toLowerCase() !== s.signature.toLowerCase()) throw new Error('Conflicting Safe signatures');
    signatures.set(s.owner.toLowerCase(), s);
  }
  return { ...a, signatures: [...signatures.values()] };
}
export async function prepareSafeExecution(provider: JsonRpcProvider, chain: ChainInfo, from: string, raw: SafeProposal): Promise<PreparedTransaction> {
  const { proposal: p, account } = await validateProposal(provider, chain, raw);
  if (p.nonce !== account.nonce) throw new Error('Queued proposal: execute earlier nonces first');
  if (p.signatures.length < account.threshold) throw new Error('Safe signature threshold not reached');
  const signatures = '0x' + p.signatures.slice(0, account.threshold).map(s => s.signature.slice(2)).join('');
  const data = abi.encodeFunctionData('execTransaction', [...txArgs(p), signatures]);
  const result = await provider.call({ from, to: p.safe_address, data });
  if (!abi.decodeFunctionResult('execTransaction', result)[0]) throw new Error('Safe execution simulation failed');
  return prepareTransaction(provider, chain, from, { to: p.safe_address, data });
}
export async function prepareSafeCreation(provider: JsonRpcProvider, chain: ChainInfo, from: string, ownersInput: string[], threshold: number, salt: string): Promise<{ address: string; owners: string[]; threshold: number; transaction: PreparedTransaction }> {
  if (!Array.isArray(ownersInput) || ownersInput.length < 2 || ownersInput.length > 50 || !Number.isInteger(threshold) || threshold < 2 || threshold > ownersInput.length || !uint(salt)) throw new Error('Use 2–50 owners, a threshold of at least 2 and a valid salt');
  const owners = ownersInput.map(o => getAddress(o));
  if (new Set(owners.map(o => o.toLowerCase())).size !== owners.length || owners.some(o => BigInt(o) <= 1n)) throw new Error('Owners must be distinct nonzero addresses');
  await requireCode(provider, SAFE_FACTORY, [FACTORY_HASH]); await requireCode(provider, SAFE_SINGLETON, [SAFE_HASH]);
  for (const owner of owners) if (await provider.getCode(owner) !== '0x') throw new Error('Creation supports EOA owners only');
  const setup = abi.encodeFunctionData('setup', [owners, threshold, ZeroAddress, '0x', ZeroAddress, ZeroAddress, 0, ZeroAddress]);
  const data = factoryAbi.encodeFunctionData('createProxyWithNonce', [SAFE_SINGLETON, setup, salt]);
  const address = getAddress(factoryAbi.decodeFunctionResult('createProxyWithNonce', await provider.call({ from, to: SAFE_FACTORY, data }))[0]);
  if (owners.includes(address)) throw new Error('Safe cannot own itself');
  return { address, owners, threshold, transaction: await prepareTransaction(provider, chain, from, { to: SAFE_FACTORY, data }) };
}
export async function safeReceipt(provider: JsonRpcProvider, hash: string, safeAddress: string, safeTxHash?: string): Promise<string> {
  if (!/^0x[a-f\d]{64}$/i.test(hash)) throw new Error('Invalid transaction hash');
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return 'pending';
  if (receipt.status !== 1) return 'failed';
  for (const log of receipt.logs) {
    if (safeTxHash && log.address.toLowerCase() === safeAddress.toLowerCase()) {
      try {
        const event = abi.parseLog(log);
        if (event?.args.txHash.toLowerCase() === safeTxHash.toLowerCase()) return event.name === 'ExecutionSuccess' ? 'confirmed' : 'failed';
      } catch { /* Other Safe event. */ }
    } else if (!safeTxHash && log.address.toLowerCase() === SAFE_FACTORY.toLowerCase()) {
      try { if (factoryAbi.parseLog(log)?.args.proxy.toLowerCase() === safeAddress.toLowerCase()) return 'confirmed'; } catch { /* Other factory event. */ }
    }
  }
  return 'unverified';
}
