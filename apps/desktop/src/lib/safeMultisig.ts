import { isValidEvmAddress } from "./evmAbi.ts";
import type { SafeCallMetadata } from "./safeAbi.ts";
import {validateSafeBatch, type SafeBatchCall} from "./safeBatch.ts";

/** Public proposal format. Never includes RPC credentials, wallet IDs or secrets. */
export interface SafeSignature { owner: string; signature: string }
export interface SafeProposal {
  version: 1;
  chain_id: number;
  safe_address: string;
  to: string;
  value: string;
  data: string;
  nonce: string;
  safe_tx_hash: string;
  signatures: SafeSignature[];
  batch?: SafeBatchCall[];
}
export interface SafeAccount {
  address: string; chain_id: number; version: string; owners: string[];
  threshold: number; nonce: string; balance_wei: string;
}
export interface SafeRecord {
  chainId: number; address: string; label: string;
  createdBy?: string; owners?: string[]; ownerLabels?: Record<string, string>;
  creationHash?: string; status?: string;
}
export function safesForWallet(safes: SafeRecord[], chainId: number, wallet?: string): SafeRecord[] {
  const address = wallet?.toLowerCase();
  return safes.filter(s => s.chainId === chainId && (!address ||
    s.createdBy?.toLowerCase() === address || s.owners?.some(o => o.toLowerCase() === address)));
}
export function proposalsForSafe(proposals: SafeProposalRecord[], chainId: number, address: string): SafeProposalRecord[] {
  return proposals.filter(r => r.proposal.chain_id === chainId && r.proposal.safe_address.toLowerCase() === address.toLowerCase())
    .sort((a, b) => BigInt(a.proposal.nonce) < BigInt(b.proposal.nonce) ? -1 : BigInt(a.proposal.nonce) > BigInt(b.proposal.nonce) ? 1 : 0);
}
export interface SafeProposalRecord {
  proposal: SafeProposal; transactionHash?: string; status?: string; call?: SafeCallMetadata;
}
export interface SafeWorkspace { safes: SafeRecord[]; proposals: SafeProposalRecord[] }
export interface SafeDiscoveryPage {
  accounts: SafeAccount[];
  from_block: number; to_block: number; latest_block: number;
  next_before_block: number | null; next_offset: number; block_span: number;
  complete: boolean; unsupported: number;
}
/** Discovery must never replace names, proposals or entries on another chain. */
export function mergeDiscoveredSafes(workspace: SafeWorkspace, accounts: SafeAccount[], chainId: number, owner: string): SafeWorkspace {
  const safes = [...workspace.safes];
  for (const account of accounts) {
    if (account.chain_id !== chainId || account.version !== "1.4.1" || !isValidEvmAddress(account.address) ||
      !Array.isArray(account.owners) || account.owners.some(o => !isValidEvmAddress(o)) ||
      !account.owners.some(o => o.toLowerCase() === owner.toLowerCase())) throw new Error("Invalid Safe discovery response");
    const index = safes.findIndex(s => s.chainId === chainId && s.address.toLowerCase() === account.address.toLowerCase());
    const old = safes[index];
    const record = { ...old, chainId, address: account.address, label: old?.label || "", owners: account.owners };
    if (index < 0) safes.push(record); else safes[index] = record;
  }
  return { ...workspace, safes };
}
export const SAFE_STORAGE_KEY = "fnzsafe.safe-multisig.v1";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT256 = /^(0|[1-9][0-9]*)$/;
function uint(value: unknown): value is string {
  return typeof value === "string" && value.length <= 78 && UINT256.test(value) && BigInt(value) < (BigInt(1) << BigInt(256));
}
export function parseSafeProposal(raw: string): SafeProposal {
  if (raw.length > 400_000) throw new Error("Proposal exceeds the size limit");
  const p = JSON.parse(raw) as SafeProposal;
  const fields = ["version", "chain_id", "safe_address", "to", "value", "data", "nonce", "safe_tx_hash", "signatures", "batch"];
  if (!p || typeof p !== "object" || Object.keys(p).some(key => !fields.includes(key)) ||
    p.version !== 1 || !Number.isSafeInteger(p.chain_id) || p.chain_id <= 0 ||
    !ADDRESS.test(p.safe_address) || !ADDRESS.test(p.to) || !uint(p.value) || !uint(p.nonce) ||
    typeof p.data !== "string" || p.data.length > 131074 || !/^0x([0-9a-fA-F]{2})*$/.test(p.data) ||
    !HASH.test(p.safe_tx_hash) || !Array.isArray(p.signatures) || p.signatures.length > 50 ||
    p.signatures.some(s => !s || Object.keys(s).some(k => k !== "owner" && k !== "signature") ||
      !ADDRESS.test(s.owner) || !/^0x[0-9a-fA-F]{130}$/.test(s.signature))) {
    throw new Error("Invalid Safe proposal format");
  }
  validateSafeBatch(p);
  return p;
}
export function sameSafeProposal(a: SafeProposal, b: SafeProposal): boolean {
  return a.chain_id === b.chain_id && a.safe_address.toLowerCase() === b.safe_address.toLowerCase() &&
    a.safe_tx_hash.toLowerCase() === b.safe_tx_hash.toLowerCase();
}
/** A response must describe exactly the transaction the user supplied/reviewed. */
export function assertSafeProposalMatches(actual: SafeProposal, expected: Pick<SafeProposal, "chain_id" | "safe_address" | "to" | "value" | "data" | "nonce" | "batch"> & { safe_tx_hash?: string }): void {
  parseSafeProposal(JSON.stringify(actual));
  if (actual.chain_id !== expected.chain_id || actual.safe_address.toLowerCase() !== expected.safe_address.toLowerCase() ||
    actual.to.toLowerCase() !== expected.to.toLowerCase() || actual.value !== expected.value || actual.nonce !== expected.nonce ||
    actual.data.toLowerCase() !== expected.data.toLowerCase() || !!actual.batch !== !!expected.batch ||
    (expected.safe_tx_hash !== undefined && actual.safe_tx_hash.toLowerCase() !== expected.safe_tx_hash.toLowerCase())) {
    throw new Error("Safe transaction response does not match the requested transaction");
  }
}
/** The backend cryptographically checks every signature after merging. */
export function mergeSafeProposals(a: SafeProposal, b: SafeProposal): SafeProposal {
  if (!sameSafeProposal(a, b) || a.to.toLowerCase() !== b.to.toLowerCase() ||
    a.value !== b.value || a.nonce !== b.nonce || a.data.toLowerCase() !== b.data.toLowerCase() || !!a.batch !== !!b.batch) {
    throw new Error("Cannot merge different Safe transactions");
  }
  const signatures = new Map<string, SafeSignature>();
  for (const s of [...a.signatures, ...b.signatures]) {
    const owner = s.owner.toLowerCase();
    const previous = signatures.get(owner);
    if (previous && previous.signature.toLowerCase() !== s.signature.toLowerCase()) {
      throw new Error("Conflicting signatures for the same owner");
    }
    signatures.set(owner, { owner, signature: s.signature });
  }
  return { ...a, signatures: [...signatures.values()].sort((x, y) => x.owner.localeCompare(y.owner)) };
}
export function loadSafeWorkspace(raw: string | null): SafeWorkspace {
  if (!raw) return { safes: [], proposals: [] };
  const data = JSON.parse(raw) as SafeWorkspace;
  if (!Array.isArray(data.safes) || !Array.isArray(data.proposals)) throw new Error("Invalid Safe workspace");
  for (const s of data.safes) {
    if (!s || !Number.isSafeInteger(s.chainId) || s.chainId <= 0 || !ADDRESS.test(s.address) || typeof s.label !== "string" ||
      (s.creationHash !== undefined && !HASH.test(s.creationHash))) throw new Error("Invalid saved Safe");
    if ((s.createdBy !== undefined && !ADDRESS.test(s.createdBy)) ||
      (s.owners !== undefined && (!Array.isArray(s.owners) || s.owners.some(o => !isValidEvmAddress(o))))) throw new Error("Invalid Safe owner metadata");
  }
  for (const s of data.safes) {
    if (s.ownerLabels !== undefined && (!s.ownerLabels || typeof s.ownerLabels !== "object" || Array.isArray(s.ownerLabels) ||
      Object.entries(s.ownerLabels).some(([address, label]) => !ADDRESS.test(address) || typeof label !== "string" || label.length > 100))) {
      throw new Error("Invalid Safe owner labels");
    }
  }
  for (const r of data.proposals) {
    parseSafeProposal(JSON.stringify(r.proposal));
    if (r.transactionHash !== undefined && !HASH.test(r.transactionHash)) throw new Error("Invalid saved transaction hash");
  }
  return data;
}

/** Reserve the next nonce among this installation’s queued proposals. */
export function nextSafeNonce(currentNonce: string, records: SafeProposalRecord[]): string {
  let next = BigInt(currentNonce);
  const used = new Set(records.map(r => r.proposal.nonce));
  while (used.has(next.toString())) next += BigInt(1);
  return next.toString();
}

export function safeProposalState(record: SafeProposalRecord, account: SafeAccount): string {
  if (record.status === "confirmed" || record.status === "failed" || record.status === "unverified") return record.status;
  if (record.transactionHash) return "pending";
  if (BigInt(record.proposal.nonce) < BigInt(account.nonce)) return "stale";
  if (BigInt(record.proposal.nonce) > BigInt(account.nonce)) return "queued";
  return record.proposal.signatures.length >= account.threshold ? "ready" : "signing";
}
export function validateSafeCreation(ownersText: string, threshold: string): string | null {
  const owners = ownersText.split(/[\s,;]+/).filter(Boolean);
  if (owners.length < 2 || owners.length > 50) return "invalidOwnerCount";
  if (owners.some(o => !isValidEvmAddress(o) || /^0x0{39}[01]$/i.test(o))) return "invalidOwnerAddress";
  if (new Set(owners.map(o => o.toLowerCase())).size !== owners.length) return "duplicateOwners";
  if (!/^\d+$/.test(threshold) || Number(threshold) < 2 || Number(threshold) > owners.length) return "invalidThreshold";
  return null;
}
export function validateSafeTransfer(to: string, amount: string, data: string, nonce: string): string | null {
  if (!isValidEvmAddress(to.trim()) || /^0x0{40}$/i.test(to.trim())) return "invalidRecipient";
  if (!/^\d+(\.\d{1,18})?$/.test(amount.trim())) return "invalidAmount";
  const [whole, fraction = ""] = amount.trim().split(".");
  if (whole.length > 78 || !uint((BigInt(whole) * BigInt("1000000000000000000") + BigInt(fraction.padEnd(18, "0"))).toString())) return "invalidAmount";
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length > 131074) return "invalidCalldata";
  if (nonce && !uint(nonce)) return "invalidNonce";
  return null;
}
