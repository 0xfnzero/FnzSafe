"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, CheckCircle2, ChevronRight, Clock3, FileJson2, Plus, RefreshCw, Search, ShieldCheck, Users, Wallet, XCircle } from "lucide-react";
import { OperationStatus } from "./OperationStatus";
import "./safe-workspace.css";
import { SafeContractCallBuilder, SafeCallSummary } from "./SafeContractCallBuilder";
import { emptySafeAbiDraft, resolveSafeAbiDraft, verifiedSafeCall, type SafeAbiDraft, type SafeCallMetadata } from "@/lib/safeAbi";
import { SafeAddress } from "./SafeAddress";
import { SafeCreateWizard, emptySafeCreation, type SafeCreationDraft } from "./SafeCreateWizard";
import { useTranslations } from "@/hooks/useTranslations";
import { apiFetch } from "@/lib/apiFetch";
import { parseDecimalAmountToUint, formatUintToDecimalAmount } from "@/lib/evmAbi";
import {
  assertSafeProposalMatches, loadSafeWorkspace, mergeSafeProposals, sameSafeProposal, SAFE_STORAGE_KEY,
  safesForWallet, proposalsForSafe, nextSafeNonce, safeProposalState, validateSafeCreation, validateSafeTransfer, type SafeAccount, type SafeProposal, type SafeProposalRecord, type SafeRecord, type SafeWorkspace,
} from "@/lib/safeMultisig";
import {MAX_SAFE_IMPORT_BYTES, parseSafeImport, safeImportTarget, type SafeTransactionFile} from "@/lib/safeTransactionImport";
import type { EvmContractChainConfig, EvmContractSavedWallet } from "./EvmContractInvokePanel";

export type SafeUiCommand = { kind: string; [key: string]: unknown };
export type SafeUiResult = {
  account?: SafeAccount; proposal?: SafeProposal; address?: string;
  gas_limit?: string; estimated_fee_wei?: string; transaction_hash?: string; status?: string;
};
export type SafeUiService = (input: {
  chain: EvmContractChainConfig; walletId: string; walletAddress: string;
  command: SafeUiCommand; approved: boolean; maxFeeWei?: string;
}) => Promise<SafeUiResult>;
const defaultService: SafeUiService = async ({ chain, walletId, walletAddress, command, approved, maxFeeWei }) => {
  const response = await apiFetch("evm/safe", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet_id: walletId, request: { chain, wallet_address: walletAddress,
      approved, max_fee_wei: maxFeeWei, command } }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
};
type Draft = { to: string; value: string; data: string; nonce: string; mode: "native" | "contract"; contractMode: "abi" | "raw"; abi: SafeAbiDraft };
const emptyDraft: Draft = { to: "", value: "0", data: "0x", nonce: "", mode: "native", contractMode: "abi", abi: emptySafeAbiDraft() };
type View = "accounts" | "account" | "create" | "load" | "propose" | "transaction" | "import";
type Review = { command: SafeUiCommand; result: SafeUiResult; label?: string; ownerLabels?: Record<string, string> };
const inputClass = "safe-input";
const buttonClass = "safe-button";

export function SafeMultisigPanel({ chains, wallets, initialChainId, initialWalletId, service = defaultService }: {
  chains: EvmContractChainConfig[]; wallets: EvmContractSavedWallet[]; initialChainId?: number; initialWalletId?: string; service?: SafeUiService;
}) {
  const translate = useTranslations();
  const t = useCallback((key: string) => translate(`features.safe-multisig.${key}`), [translate]);
  const [chainId, setChainId] = useState(initialChainId || 97);
  const chain = chains.find(c => c.chain_id === chainId);
  const [walletId, setWalletId] = useState(initialWalletId || "");
  const [showAll, setShowAll] = useState(false);
  const wallet = wallets.find(w => w.id === walletId && w.evm_address);
  const [workspace, setWorkspace] = useState<SafeWorkspace>({ safes: [], proposals: [] });
  const [storageReady, setStorageReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("working");
  const [search, setSearch] = useState("");
  const [accountLoading, setAccountLoading] = useState(false);
  const [receiptStopped, setReceiptStopped] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [address, setAddress] = useState("");
  const [account, setAccount] = useState<SafeAccount>();
  const [creationDraft, setCreationDraft] = useState<SafeCreationDraft>(emptySafeCreation);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftKey = `${chainId}:${account?.address.toLowerCase() || ""}`;
  const draft = { ...emptyDraft, ...drafts[draftKey] };
  const { to, value, data, nonce: nonceOverride } = draft;
  const setDraft = (change: Partial<Draft>) => setDrafts(prev => ({ ...prev, [draftKey]: { ...(prev[draftKey] || emptyDraft), ...change } }));
  const setTo = (to: string) => setDraft({ to });
  const setValue = (value: string) => setDraft({ value });
  const setData = (data: string) => setDraft({ data });
  const setNonceOverride = (nonce: string) => setDraft({ nonce });
  const [record, setRecord] = useState<SafeProposalRecord>();
  const [exchange, setExchange] = useState("");
  const [transactionImport,setTransactionImport]=useState<SafeTransactionFile>();
  const [importAddress,setImportAddress]=useState("");
  const [importIndex,setImportIndex]=useState(0);
  const [review, setReview] = useState<Review>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const reviewTriggerRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  const workspaceRef = useRef(workspace);
  const [storageError, setStorageError] = useState("");
  const [view, setView] = useState<View>("accounts");
  const [backView, setBackView] = useState<View>("accounts");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const transferMode = draft.mode;
  const setTransferMode = (mode: Draft["mode"]) => setDraft({ mode, value: "0" });
  const abiCall = useMemo(() => resolveSafeAbiDraft(draft.abi), [draft.abi]);
  const usingAbi = transferMode === "contract" && draft.contractMode === "abi";
  const callData = transferMode === "native" ? "0x" : usingAbi ? abiCall.data || "" : data;
  const callValue = usingAbi && abiCall.fn?.stateMutability !== "payable" ? "0" : value;
  const [autoReceipt, setAutoReceipt] = useState<{ address: string; hash: string; safeHash?: string }>();
  const blocked = busy || (!!review && review.command.kind !== "create");
  const transferError = (usingAbi && abiCall.error) || validateSafeTransfer(to, callValue, callData, nonceOverride);
  const txState = record && account ? safeProposalState(record, account) : undefined;
  const signReason = !wallet ? "selectWallet" : txState === "stale" ? "stale" : record?.transactionHash ? "alreadySubmitted" :
    !account?.owners.some(o => o.toLowerCase() === wallet.evm_address?.toLowerCase()) ? "notOwner" :
    record?.proposal.signatures.some(s => s.owner.toLowerCase() === wallet.evm_address?.toLowerCase()) ? "alreadySigned" : "";
  const executeReason = !wallet ? "selectWallet" : record?.transactionHash ? "alreadySubmitted" : txState === "stale" ? "stale" :
    txState === "queued" ? "queued" : record && account && record.proposal.signatures.length < account.threshold ? "needSignatures" : "";
  const safes = safesForWallet(workspace.safes, chainId, showAll ? undefined : wallet?.evm_address || undefined);
  const visibleSafes = safes.filter(s => `${s.label} ${s.address}`.toLowerCase().includes(search.trim().toLowerCase()));
  const proposals = proposalsForSafe(workspace.proposals, chainId, account?.address || "");

  useEffect(() => {
    try {
      const stored = loadSafeWorkspace(localStorage.getItem(SAFE_STORAGE_KEY));
      workspaceRef.current = stored; setWorkspace(stored); setStorageReady(true);
    } catch { setStorageError(t("storageError")); }
  }, [t]);
  useEffect(() => {
    if (review && review.command.kind !== "create" && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
      cancelRef.current?.focus({ preventScroll: true });
      // showModal's automatic focus can scroll a long financial review to its footer.
      // Always open at the transaction details while retaining the safe Cancel default.
      dialogRef.current.scrollTop = 0;
      restoreFocusRef.current = true;
    } else if (!review && !busy && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      const trigger = reviewTriggerRef.current;
      if (trigger?.isConnected && !trigger.matches(":disabled")) trigger.focus({ preventScroll: true });
      else headingRef.current?.focus({ preventScroll: true });
    }
  }, [review, busy]);
  useEffect(() => {
    if (error || message) feedbackRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error, message]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [view]);
  function navigate(next: View, parent: View = next === "transaction" || next === "propose" ? "account" : "accounts") {
    setReceiptStopped(false);
    if (["accounts", "create", "load", "import"].includes(next)) setAutoReceipt(undefined);
    if (next === "import") setTransactionImport(undefined);
    if (review?.command.kind === "create") setReview(undefined);
    if (next === "create" && creationDraft.owners.every(o => !o.address)) {
      setCreationDraft(previous => ({ ...previous, owners: previous.owners.map((o, index) => index === 0 ? { ...o, address: wallet?.evm_address || "", name: wallet?.name || "" } : o) }));
    }
    setBackView(parent); setView(next); setError(""); setMessage("");
  }
  function persist(update: (previous: SafeWorkspace) => SafeWorkspace) {
    const next = update(workspaceRef.current);
    workspaceRef.current = next; setWorkspace(next);
    try { localStorage.setItem(SAFE_STORAGE_KEY, JSON.stringify(next)); setStorageError(""); }
    catch { setStorageError(t("storageError")); }
  }
  function saveSafe(safe: SafeRecord) {
    persist(previous => {
      const existing = previous.safes.find(s => s.chainId === safe.chainId && s.address.toLowerCase() === safe.address.toLowerCase());
      return { ...previous, safes: existing ? previous.safes.map(s => s === existing ? { ...existing, ...safe } : s) : [...previous.safes, safe] };
    });
  }
  function saveProposal(p: SafeProposal, update: Partial<SafeProposalRecord> = {}, info?: SafeAccount) {
    persist(previous => {
      const existing = previous.proposals.find(r => sameSafeProposal(r.proposal, p));
      const next = { ...existing, ...update, proposal: p };
      setRecord(next);
      const existingSafe = previous.safes.find(s => s.chainId === p.chain_id && s.address.toLowerCase() === p.safe_address.toLowerCase());
      const safe = { ...existingSafe, chainId: p.chain_id, address: p.safe_address, label: existingSafe?.label || "", owners: info?.owners || existingSafe?.owners };
      return {
        safes: existingSafe ? previous.safes.map(s => s === existingSafe ? safe : s) : [...previous.safes, safe],
        proposals: existing ? previous.proposals.map(r => r === existing ? next : r) : [...previous.proposals, next],
      };
    });
  }
  const request = useCallback(async (command: SafeUiCommand, approved = false, maxFeeWei?: string): Promise<SafeUiResult> => {
    if (!chain) throw new Error(t("selectNetwork"));
    const pending = service({ chain, walletId: wallet?.id || "", walletAddress: wallet?.evm_address || "", command, approved, maxFeeWei });
    // Bound read-only waits. Never timeout or automatically retry an approved write:
    // it may have been broadcast even when its response has not reached the UI.
    if (approved || !["account", "validate", "prepare_create", "prepare_execute", "receipt"].includes(command.kind)) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t("readTimeout"))), 30_000);
      })]);
    } finally { clearTimeout(timer); }
  }, [chain, wallet, service, t]);
  async function run(action: () => Promise<void>, label = "working") {
    if (lock.current) return;
    reviewTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lock.current = true; setOperation(label); setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  function changeNetwork(next: number, creating = false) {
    setReceiptStopped(false); setSearch("");
    setChainId(next); setAccount(undefined); setRecord(undefined); setAddress(""); setAutoReceipt(undefined);
    setReview(undefined); setError(""); setMessage(""); setExchange(""); setTransactionImport(undefined); setView(creating ? "create" : "accounts");
  }
  async function query(target: string, stay = false) {
    if (!stay) {
      setAddress(target); setAccount(undefined); setRecord(undefined);
      setView("account"); setBackView("accounts"); setAccountLoading(true);
    }
    try {
      const result = await request({ kind: "account", address: target });
      if (!result.account) throw new Error(t("invalidResponse"));
      const same = account?.address.toLowerCase() === result.account.address.toLowerCase();
      setAccount(result.account); setAddress(result.account.address);
      if (!same) setRecord(undefined);
      if (!stay) { setView("account"); setBackView("accounts"); }
      const old = workspaceRef.current.safes.find(s => s.chainId === chainId && s.address.toLowerCase() === result.account!.address.toLowerCase());
      saveSafe({ ...old, chainId, address: result.account.address, label: old?.label || "", owners: result.account.owners });
    } finally { setAccountLoading(false); }
  }
  async function prepareCreate() {
    const parsedOwners = creationDraft.owners.map(o => o.address.trim());
    const creationError = validateSafeCreation(parsedOwners.join("\n"), String(creationDraft.threshold));
    if (creationError) throw new Error(t(creationError));
    if (!creationDraft.label.trim() || parsedOwners.some(o => !o)) throw new Error(t("invalidResponse"));
    const salt = BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")}`).toString();
    const command = { kind: "prepare_create", owners: parsedOwners, threshold: creationDraft.threshold, salt_nonce: salt };
    const result = await request(command);
    if (!result.address || !result.estimated_fee_wei) throw new Error(t("invalidResponse"));
    setReview({ command: { ...command, kind: "create" }, result, label: creationDraft.label.trim(),
      ownerLabels: Object.fromEntries(creationDraft.owners.filter(o => o.name.trim()).map(o => [o.address.trim().toLowerCase(), o.name.trim()])) });
  }
  async function importProposal() {
    let file;
    try {file=parseSafeImport(exchange);}catch(e){throw new Error(t(e instanceof Error?e.message:"invalidTransactionFile"));}
    if(file.kind==="transactions") {
      if(file.chainId!==chainId)throw new Error(t("wrongNetwork"));
      if(file.safeAddress&&backView!=="accounts"&&account&&file.safeAddress.toLowerCase()!==account.address.toLowerCase())throw new Error(t("wrongImportSafe"));
      setTransactionImport(file);setImportIndex(0);setImportAddress(file.safeAddress||account?.address||"");
      setMessage(t("importPreview"));return;
    }
    const imported=file.proposal;
    if (imported.chain_id !== chainId) throw new Error(t("wrongNetwork"));
    const old = workspace.proposals.find(r => sameSafeProposal(r.proposal, imported));
    const proposal = old ? mergeSafeProposals(old.proposal, imported) : imported;
    const result = await request({ kind: "validate", proposal });
    if (!result.proposal || !result.account) throw new Error(t("invalidResponse"));
    assertSafeProposalMatches(result.proposal, proposal);
    setAccount(result.account); setAddress(result.account.address); saveProposal(result.proposal, {}, result.account);
    setView("transaction"); setBackView("account"); setMessage(t("imported"));
  }
  async function importTransaction() {
    if(!transactionImport)return;
    let target;
    try{target=safeImportTarget(transactionImport,chainId,importAddress.trim());}catch(e){throw new Error(t(e instanceof Error?e.message:"invalidTransactionFile"));}
    if(backView!=="accounts"&&account&&account.address.toLowerCase()!==target.toLowerCase())throw new Error(t("wrongImportSafe"));
    const transaction=transactionImport.transactions[importIndex];
    if(!transaction)throw new Error(t("invalidTransactionFile"));
    const current=await request({kind:"account",address:target});
    if(!current.account||current.account.chain_id!==chainId||current.account.address.toLowerCase()!==target.toLowerCase())throw new Error(t("invalidResponse"));
    const expected={chain_id:chainId,safe_address:target,...transaction,
      nonce:nextSafeNonce(current.account.nonce,proposalsForSafe(workspaceRef.current.proposals,chainId,target))};
    const result=await request({kind:"propose",address:target,to:expected.to,value:expected.value,data:expected.data,nonce:expected.nonce});
    if(!result.proposal||!result.account||result.account.chain_id!==chainId||result.account.address.toLowerCase()!==target.toLowerCase())throw new Error(t("invalidResponse"));
    assertSafeProposalMatches(result.proposal,expected);
    if(result.proposal.signatures.length)throw new Error(t("invalidResponse"));
    setAccount(result.account);setAddress(target);saveProposal(result.proposal,{},result.account);
    setView("transaction");setBackView("account");setMessage(t("importTransactionReady"));
  }
  async function prepareAction(kind: "sign" | "execute") {
    if (!record || !wallet) return;
    const result = await request({ kind: kind === "sign" ? "validate" : "prepare_execute", proposal: record.proposal });
    if (!result.proposal || !result.account) throw new Error(t("invalidResponse"));
    assertSafeProposalMatches(result.proposal, record.proposal);
    setAccount(result.account);
    setReview({ command: { kind, proposal: result.proposal }, result });
  }
  async function confirm() {
    if (!review) return;
    const current = review;
    // A broadcast error can be ambiguous. Clear approval even when it fails;
    // never automatically retry a financial operation in this component.
    // Keep the creation review visible while submitting so the wizard does not
    // jump back to the signer step. Clear its approval on either outcome.
    if (current.command.kind !== "create") setReview(undefined);
    const result = await request(current.command, true, current.result.estimated_fee_wei)
      .finally(() => { if (current.command.kind === "create") setReview(undefined); });
    if (current.command.kind === "create" && result.address && result.transaction_hash) {
      setAddress(result.address); setAccount(undefined); setRecord(undefined); setView("account"); setBackView("accounts");
      setAutoReceipt({ address: result.address, hash: result.transaction_hash });
      saveSafe({ chainId, address: result.address, label: current.label || "", creationHash: result.transaction_hash, status: "pending", createdBy: wallet?.evm_address || undefined, owners: current.command.owners as string[], ownerLabels: current.ownerLabels });
      setCreationDraft(emptySafeCreation());
      setMessage(`${t("submitted")} ${result.transaction_hash}`);
    } else if (current.command.kind === "sign" && result.proposal) {
      assertSafeProposalMatches(result.proposal, current.command.proposal as SafeProposal);
      saveProposal(result.proposal, {}, result.account); setMessage(t("signed"));
    } else if (current.command.kind === "execute" && result.transaction_hash) {
      saveProposal(current.command.proposal as SafeProposal, { transactionHash: result.transaction_hash, status: "pending" });
      setAutoReceipt({ address: (current.command.proposal as SafeProposal).safe_address, hash: result.transaction_hash, safeHash: (current.command.proposal as SafeProposal).safe_tx_hash });
      setMessage(`${t("submitted")} ${result.transaction_hash}`);
    } else { throw new Error(t("invalidResponse")); }
  }
  async function refreshReceipt(safe?: SafeRecord) {
    setReceiptStopped(false);
    setAutoReceipt(undefined);
    const txHash = safe?.creationHash || record?.transactionHash;
    const target = safe?.address || record?.proposal.safe_address;
    if (!txHash || !target) return;
    const result = await request({ kind: "receipt", address: target, transaction_hash: txHash,
      safe_tx_hash: safe ? null : record?.proposal.safe_tx_hash });
    if (safe) {
      saveSafe({ ...safe, status: result.status, owners: result.account?.owners || safe.owners });
      if (result.account) { setAccount(result.account); setAddress(result.account.address); if (record?.proposal.safe_address.toLowerCase() !== result.account.address.toLowerCase()) setRecord(undefined); }
    } else if (record) {
      saveProposal(record.proposal, { status: result.status });
      if (result.status === "confirmed") {
        try {
          const refreshed = await request({ kind: "account", address: target });
          if (refreshed.account) setAccount(refreshed.account);
        } catch { setError(t("refreshAfterReceipt")); }
      }
    }
    setMessage(t(`status.${result.status || "unverified"}`));
  }
  useEffect(() => {
    if (!autoReceipt || review) return;
    setReceiptStopped(false);
    let cancelled = false;
    let attempts = 0;
    let inFlight = false;
    const timer = setInterval(() => {
      if (lock.current || inFlight) return;
      if (++attempts > 20) {
        clearInterval(timer); setReceiptStopped(true); setAutoReceipt(undefined); return;
      }
      inFlight = true;
      void request({ kind: "receipt", address: autoReceipt.address, transaction_hash: autoReceipt.hash, safe_tx_hash: autoReceipt.safeHash || null })
        .then(async result => {
          if (cancelled || !result.status || result.status === "pending") return;
          clearInterval(timer);
          const refreshed = result.account || (result.status === "confirmed" ?
            await request({ kind: "account", address: autoReceipt.address }).then(r => r.account).catch(() => undefined) : undefined);
          if (cancelled) return;
          persist(previous => ({
            safes: previous.safes.map(s => s.chainId === chainId && s.address.toLowerCase() === autoReceipt.address.toLowerCase() ?
              { ...s, ...(autoReceipt.safeHash ? {} : { status: result.status }), owners: refreshed?.owners || s.owners } : s),
            proposals: previous.proposals.map(r => r.transactionHash === autoReceipt.hash ? { ...r, status: result.status } : r),
          }));
          setRecord(previous => previous?.transactionHash === autoReceipt.hash ? { ...previous, status: result.status } : previous);
          if (refreshed && (!account || account.address.toLowerCase() === autoReceipt.address.toLowerCase())) {
            setAccount(refreshed); setAddress(refreshed.address);
          }
          setMessage(t(`status.${result.status}`)); setAutoReceipt(undefined);
        }).catch(() => { /* manual receipt lookup remains available */ }).finally(() => { inFlight = false; });
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
    // The poll is tied to this submission and its network, not changing signer state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReceipt, chainId, review, request]);
  function downloadProposal() {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record.proposal, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `safe-${chainId}-${record.proposal.safe_tx_hash}.json`;
    a.click(); URL.revokeObjectURL(url);
  }
  function selectRecord(next: SafeProposalRecord) {
    setRecord(next); setError(""); setMessage(""); setView("transaction"); setBackView("account");
    setAutoReceipt(next.transactionHash && (!next.status || next.status === "pending") ?
      { address: next.proposal.safe_address, hash: next.transactionHash, safeHash: next.proposal.safe_tx_hash } : undefined);
  }
  const selectedSafe = workspace.safes.find(s => s.chainId === chainId && s.address.toLowerCase() === (account?.address || address).toLowerCase());
  const safeTitle = selectedSafe?.label || t("unnamedSafe");
  const titles: Record<View, string> = { accounts: "accounts", account: "proposals", create: "create", load: "loadExisting", propose: "propose", transaction: "transactionDetails", import: "import" };
  const primaryClass = `${buttonClass} safe-button-primary`;
  async function openSafe(safe: SafeRecord) {
    setReceiptStopped(false);
    setAutoReceipt(undefined);
    if (safe.creationHash && safe.status !== "confirmed") {
      setAddress(safe.address); setAccount(undefined); setRecord(undefined); setView("account"); setBackView("accounts");
      if (!safe.status || safe.status === "pending") setAutoReceipt({ address: safe.address, hash: safe.creationHash });
    } else await query(safe.address);
  }
  async function createProposal() {
    if (!account || transferError) return;
    const expected = { chain_id: chainId, safe_address: account.address, to: to.trim(), value: parseDecimalAmountToUint(callValue, 18),
      data: callData, nonce: nonceOverride || nextSafeNonce(account.nonce, proposals) };
    const result = await request({ kind: "propose", address: expected.safe_address, to: expected.to, value: expected.value, data: expected.data, nonce: expected.nonce });
    if (!result.proposal) throw new Error(t("invalidResponse"));
    assertSafeProposalMatches(result.proposal, expected);
    setAccount(result.account); saveProposal(result.proposal, { call: usingAbi ? verifiedSafeCall(abiCall.metadata, result.proposal) : undefined }, result.account); setNonceOverride("");
    setView("transaction"); setBackView("account");
  }
  return <div className="safe-workspace space-y-6">
    {view !== "create" && <fieldset disabled={blocked || !storageReady} className="safe-context grid gap-4 md:grid-cols-2">
      <label className="space-y-2 text-xs font-medium text-muted-foreground">{t("network")}
        <select className={inputClass} value={chainId} onChange={e => changeNetwork(Number(e.target.value))}>
          {!chain && <option value={chainId}>{t("selectNetwork")}</option>}
          {chains.map(c => <option key={c.chain_id} value={c.chain_id}>{c.name} · {c.chain_id} · {c.testnet ? t("testnet") : t("mainnet")}</option>)}
        </select>
      </label>
      <label className="space-y-2 text-xs font-medium text-muted-foreground">{t("signer")}
        <select className={inputClass} value={walletId} onChange={e => setWalletId(e.target.value)}>
          <option value="">{t("selectWallet")}</option>
          {wallets.filter(w => w.evm_address).map(w => <option key={w.id} value={w.id}>{w.name} · {w.evm_address}</option>)}
        </select>
      </label>
    </fieldset>}
    <nav aria-label={t("navigation")} className="safe-breadcrumb flex flex-wrap items-center gap-2 text-xs">
      <button disabled={blocked || view === "accounts"} onClick={() => navigate("accounts")}>{t("accounts")}</button>
      {(["account", "propose", "transaction"].includes(view) || (view === "import" && backView !== "accounts")) && <><ChevronRight size={13} aria-hidden="true" /><button disabled={blocked || view === "account"} onClick={() => navigate("account")}>{safeTitle}</button></>}
      {view === "import" && backView === "transaction" && <><ChevronRight size={13} aria-hidden="true" /><button disabled={blocked} onClick={() => navigate("transaction")}>{t("transactionDetails")}</button></>}
      {!["accounts", "account"].includes(view) && <><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">{t(titles[view])}</span></>}
    </nav>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-4">
        <span className="safe-icon"><ShieldCheck size={25} aria-hidden="true" /></span>
        <div className="min-w-0"><h2 ref={headingRef} tabIndex={-1} className="break-words text-2xl font-semibold tracking-tight outline-none">{view === "account" ? safeTitle : t(titles[view])}</h2>
          {["accounts", "account"].includes(view) && <p className="mt-1.5 text-sm text-muted-foreground">{t(view === "accounts" ? "workspaceSubtitle" : "accountSubtitle")}</p>}
        </div>
      </div>
      {view !== "accounts" && view !== "create" && <button disabled={blocked} className={buttonClass} onClick={() => navigate(backView)}><ArrowLeft size={15} />{t("back")}</button>}
    </div>
    {!chain && <p role="status" className="text-sm text-amber-400">{t("networksLoading")}</p>}
    {wallets.filter(w => w.evm_address).length === 0 && <p className="text-sm text-amber-400">{t("noWallets")}</p>}
    {storageError && <div role="alert" className="rounded-lg border border-amber-400/40 p-3 text-sm">{storageError}</div>}
    <div ref={feedbackRef} className="space-y-3" aria-live="polite">
      {error && <div role="alert" className="safe-feedback safe-feedback-error">{error}</div>}
      {message && <div role="status" className="safe-feedback safe-feedback-success">{message}</div>}
    </div>
    {busy && <OperationStatus floating label={t(operation)} detail={operation === "loadingAccount" ? t("loadingAccountHint") : undefined}
      slowDetail={["loadingAccount", "refreshingAccount", "checkingReceipt", "checkingTransaction", "preparingSignature", "preparingExecution", "preparingCreation"].includes(operation) ? t("readSlow") : undefined}
      />}
    {autoReceipt && !busy && <OperationStatus label={t("awaitingConfirmation")} detail={t("receiptHint")} slowDetail={t("receiptHint")} />}
    {receiptStopped && !autoReceipt && <p role="status" className="safe-feedback">{t("receiptStopped")}</p>}
    {review && review.command.kind !== "create" && <dialog ref={dialogRef} aria-label={t("review")} onCancel={e => { e.preventDefault(); if (!busy) setReview(undefined); }} className="safe-review m-auto max-h-[85vh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-border bg-background p-6 text-foreground shadow-2xl backdrop:bg-black/70">
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-xl font-semibold"><ShieldCheck className="text-emerald-500" size={22} />{t("review")} · {t(review.command.kind)}</h3>
        <p>{chain?.name} ({chainId}) · {chain?.testnet ? t("testnet") : t("mainnet")}</p>
        <p className="break-all text-sm">{t("signer")}: {wallet?.evm_address}</p>
        {review.result.proposal && <ProposalDetails proposal={review.result.proposal} call={record?.call} t={t} symbol={chain?.native_symbol} />}
        {review.result.estimated_fee_wei && <p>{t("estimatedFee")}: {formatUintToDecimalAmount(review.result.estimated_fee_wei, 18)} {chain?.native_symbol}</p>}
        <p className="text-sm">{review.command.kind === "sign" ? t("signWarning") : t("gasHint")}</p>
        <div className="flex gap-2">
          <button ref={cancelRef} className={buttonClass} disabled={busy} onClick={() => setReview(undefined)}>{t("cancel")}</button>
          <button className={primaryClass} disabled={busy} onClick={() => void run(confirm, review?.command.kind === "sign" ? "signingTransaction" : "submittingTransaction")}>{t("confirm")}</button>
        </div>
      </div>
    </dialog>}
    <fieldset disabled={blocked || !storageReady || (!chain && view !== "create")} className="space-y-5" aria-busy={busy}>
      {view === "accounts" && <>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">{t("savedLocally")} <span className="safe-count ml-2">{safes.length}</span></span>
          <div className="flex flex-wrap gap-2">
            <button className={buttonClass} onClick={() => navigate("import")}><FileJson2 size={16} />{t("import")}</button>
            <button className={buttonClass} onClick={() => navigate("load")}><ArrowDownToLine size={16} />{t("loadExisting")}</button>
            <button className={primaryClass} onClick={() => navigate("create")}><Plus size={16} />{t("create")}</button>
          </div>
        </div>
        <div className="safe-list-toolbar">
          <label className="relative block min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={17} />
            <input className={`${inputClass} !pl-10`} aria-label={t("searchAccounts")} placeholder={t("searchAccounts")} value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={showAll} onChange={e => setShowAll(e.target.checked)} />{t("showAll")}</label>
        </div>
        {!storageReady && !storageError && <AccountSkeleton />}
        {storageReady && visibleSafes.length === 0 && <div className="safe-empty">
          <ShieldCheck size={32} className="mb-3 text-muted-foreground" aria-hidden="true" />
          <h3 className="font-semibold">{t(search.trim() ? "noSearchResults" : "noAccounts")}</h3>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">{t("emptyAccountsHint")}</p>
          {search.trim() && <button className={`${buttonClass} mt-4`} onClick={() => setSearch("")}>{t("clearSearch")}</button>}
        </div>}
        <div className="grid gap-4 xl:grid-cols-2">{visibleSafes.map(s => <article key={s.address} className="safe-account-card">
          <button type="button" className="safe-account-link" onClick={() => void run(() => openSafe(s), "loadingAccount")}>
            <span className="safe-icon"><ShieldCheck size={22} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1"><span className="block break-words text-base font-semibold">{s.label || t("unnamedSafe")}</span>
              <span className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{chain?.name}</span><span className="safe-badge">{t(chain?.testnet ? "testnet" : "mainnet")}</span></span>
            </span>
            <ChevronRight size={18} className="text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">{t("openAccount")}</span>
          </button>
          <div className="px-5 pb-4"><SafeAddress address={s.address} /></div>
          <div className="safe-account-footer">
            <span className="inline-flex items-center gap-2"><FileJson2 size={14} />{proposalsForSafe(workspace.proposals, chainId, s.address).length} {t("savedTransactions")}</span>
            <span className="inline-flex items-center gap-2">{s.creationHash && s.status !== "confirmed" ? <><Clock3 size={14} />{t(`status.${s.status || "pending"}`)}</> : s.owners && <><Users size={14} />{s.owners.length} {t("members")}</>}</span>
          </div>
        </article>)}</div>
      </>}
      {view === "load" && <div className="safe-form space-y-5">
        <label className="block text-sm">{t("safeAddress")}<input className={inputClass} value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" /></label>
        <button className={primaryClass} disabled={!/^0x[0-9a-fA-F]{40}$/.test(address.trim())} onClick={() => { setAutoReceipt(undefined); void run(() => query(address.trim()), "loadingAccount"); }}>{t("load")}</button>
      </div>}
      {view === "create" && <SafeCreateWizard
        chains={chains} chainId={chainId} wallets={wallets} walletId={walletId} draft={creationDraft} busy={busy}
        preview={review?.command.kind === "create" ? { address: review.result.address!, estimatedFee: review.result.estimated_fee_wei! } : undefined}
        onDraftChange={next => { setCreationDraft(next); setReview(undefined); setError(""); }}
        onChainChange={next => changeNetwork(next, true)} onWalletChange={next => { setWalletId(next); setReview(undefined); }}
        onPrepare={() => void run(prepareCreate, "preparingCreation")} onEdit={() => { setReview(undefined); setError(""); }}
        onConfirm={() => void run(confirm, review?.command.kind === "sign" ? "signingTransaction" : "submittingTransaction")} onCancel={() => navigate("accounts")}
      />}
      {view === "account" && !account && <>
        {accountLoading ? <AccountSkeleton /> : selectedSafe?.creationHash && selectedSafe.status !== "confirmed" ? <div className="safe-surface space-y-4">
          <span className="safe-badge"><Clock3 size={14} />{t(`status.${selectedSafe.status || "pending"}`)}</span><SafeAddress address={selectedSafe.address} />
          <p className="break-all text-sm text-muted-foreground">{t("transactionHash")}: {selectedSafe.creationHash}</p>
          <button className={buttonClass} onClick={() => void run(() => refreshReceipt(selectedSafe), "checkingReceipt")}><RefreshCw size={15} />{t("receipt")}</button>
        </div> : <div className="safe-empty">
          <XCircle size={30} className="mb-3 text-muted-foreground" /><h3 className="font-semibold">{t("accountLoadFailed")}</h3>
          <p className="mb-4 mt-2 text-sm text-muted-foreground">{t("accountLoadFailedHint")}</p>
          <SafeAddress address={address} />
          <button className={`${buttonClass} mt-4`} onClick={() => void run(() => query(address), "loadingAccount")}><RefreshCw size={15} />{t("retry")}</button>
        </div>}
      </>}
      {view === "account" && account && <>
        <section className="safe-surface space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0"><p className="mb-1 text-xs text-muted-foreground">{t("safeAddress")}</p><SafeAddress address={account.address} /></div>
            <button className={buttonClass} aria-busy={busy && operation === "refreshingAccount"} onClick={() => void run(() => query(account.address, true), "refreshingAccount")}><RefreshCw size={15} className={busy && operation === "refreshingAccount" ? "animate-spin" : ""} />{t("refreshAccount")}</button>
          </div>
          <dl className="safe-stats">
            <div><dt><Wallet size={15} />{t("balance")}</dt><dd className="break-all">{formatUintToDecimalAmount(account.balance_wei, 18)} <span className="text-sm font-medium text-muted-foreground">{chain?.native_symbol}</span></dd></div>
            <div><dt><ShieldCheck size={15} />{t("signaturePolicy")}</dt><dd>{account.threshold}<span className="text-base font-normal text-muted-foreground"> / {account.owners.length}</span></dd></div>
            <div><dt><Clock3 size={15} />Nonce</dt><dd>{account.nonce}</dd><p className="mt-1 text-xs text-muted-foreground">{t("nonceHintShort")}</p></div>
          </dl>
          <details className="safe-owners"><summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Users size={16} />{t("accountOwners")}<span className="safe-count">{account.owners.length}</span><ChevronRight className="ml-auto" size={16} /></summary>
            <ul className="mt-4 grid gap-3 xl:grid-cols-2">{account.owners.map((owner, index) => <li key={owner} className="safe-owner">
              <span className="safe-owner-number">{index + 1}</span><div className="min-w-0"><p className="mb-1 text-xs font-medium">{selectedSafe?.ownerLabels?.[owner.toLowerCase()] || `${t("signer")} ${index + 1}`}</p><SafeAddress address={owner} /></div>
            </li>)}</ul>
          </details>
        </section>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h3 className="text-lg font-semibold">{t("proposals")} <span className="safe-count ml-2">{proposals.length}</span></h3><p className="mt-1 text-xs text-muted-foreground">{t("localTransactionsHint")}</p></div>
          <div className="flex flex-wrap gap-2"><button className={buttonClass} onClick={() => navigate("import", "account")}><ArrowDownToLine size={16} />{t("import")}</button><button className={primaryClass} onClick={() => navigate("propose", "account")}><Plus size={16} />{t("propose")}</button></div>
        </div>
        {proposals.length === 0 && <div className="safe-empty"><FileJson2 size={30} className="mb-3 text-muted-foreground" /><h4 className="font-medium">{t("noProposals")}</h4><p className="mt-2 text-sm text-muted-foreground">{t("emptyProposalsHint")}</p></div>}
        <div className="space-y-3">{proposals.map(r => <button className="safe-transaction-row" key={r.proposal.safe_tx_hash} onClick={() => selectRecord(r)}>
          <span className="safe-icon"><ArrowUpRight size={20} /></span>
          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-3"><span className="font-semibold">{formatUintToDecimalAmount(r.proposal.value, 18)} {chain?.native_symbol}</span><span className="text-xs text-muted-foreground">#{r.proposal.nonce}</span></span>
            <span className="mt-1.5 block break-all font-mono text-xs text-muted-foreground">{r.proposal.to}</span></span>
          <span className="space-y-2 text-right"><StatusBadge state={safeProposalState(r, account)} label={t(`transactionState.${safeProposalState(r, account)}`)} /><span className="block text-xs text-muted-foreground">{t("signatures")} {r.proposal.signatures.length}/{account.threshold}</span></span>
          <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
        </button>)}</div>
      </>}
      {view === "propose" && account && <div className="safe-form space-y-5">
        <div className="space-y-1"><p className="text-sm text-muted-foreground">{t("safeAddress")}</p><SafeAddress address={account.address} /></div>
        <label className="block text-sm">{t("transactionType")}<select className={inputClass} value={transferMode} onChange={e => setTransferMode(e.target.value as Draft["mode"])}><option value="native">{t("nativeTransfer")}</option><option value="contract">{t("contractCall")}</option></select></label>
        <label className="block text-sm">{t(transferMode === "contract" ? "abiContractAddress" : "recipient")}<input className={inputClass} value={to} onChange={e => setTo(e.target.value)} placeholder="0x…" /></label>
        {transferMode === "contract" && <>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("abiInputMode")}>
            <button type="button" className={buttonClass} aria-pressed={usingAbi} onClick={() => { if (!usingAbi) setDraft({ contractMode: "abi", value: "0" }); }}>{t("abiFormMode")}</button>
            <button type="button" className={buttonClass} aria-pressed={!usingAbi} onClick={() => { if (usingAbi) setDraft({ contractMode: "raw", data: abiCall.data || data, value: "0" }); }}>{t("abiRawMode")}</button>
          </div>
          {usingAbi ? <SafeContractCallBuilder key={draftKey} draft={draft.abi} chainId={chainId} t={t} onChange={(abi, target) => setDraft({ abi, ...(abi.signature !== draft.abi.signature || abi.text !== draft.abi.text ? { value: "0" } : {}), ...(target ? { to: target } : {}) })} /> :
            <><label className="block text-sm">{t("calldata")}<textarea className={`${inputClass} font-mono`} rows={5} value={data} onChange={e => setData(e.target.value)} /></label><p className="text-xs text-muted-foreground">{t("callHint")}</p></>}
        </>}
        {(!usingAbi || abiCall.fn?.stateMutability === "payable") && <label className="block text-sm">{t(usingAbi ? "abiNativeValue" : "amount")} ({chain?.native_symbol})<input className={inputClass} inputMode="decimal" value={callValue} onChange={e => setValue(e.target.value)} /></label>}
        <details><summary className="cursor-pointer text-sm">{t("advancedNonce")} · {nonceOverride || nextSafeNonce(account.nonce, proposals)}</summary>
          <label className="block text-sm">{t("nonce")}<input className={inputClass} inputMode="numeric" value={nonceOverride} placeholder={nextSafeNonce(account.nonce, proposals)} onChange={e => setNonceOverride(e.target.value)} /></label>
          <p className="text-xs text-muted-foreground">{t("nonceHint")}</p>
        </details>
        {transferError && <p className="text-sm text-amber-400">{t(transferError)}</p>}
        <button className={primaryClass} disabled={!!transferError} onClick={() => void run(createProposal, "creatingProposal")}>{t("propose")}</button>
      </div>}
      {view === "transaction" && record && <section className="safe-surface space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><StatusBadge state={txState || "pending"} label={txState ? t(`transactionState.${txState}`) : t("working")} /><button className={buttonClass} onClick={() => void run(async () => {
          if (record.transactionHash) { await refreshReceipt(); return; }
          const result = await request({ kind: "validate", proposal: record.proposal });
          if (result.proposal) { assertSafeProposalMatches(result.proposal, record.proposal); saveProposal(result.proposal, {}, result.account); setAccount(result.account); setMessage(t("validated")); }
        }, "checkingTransaction")}><RefreshCw size={15} />{t("refreshTransaction")}</button></div>
        <ProposalDetails proposal={record.proposal} call={record.call} t={t} symbol={chain?.native_symbol} />
        <div className="safe-signatures">
          <div className="mb-3 flex items-center justify-between gap-3 text-sm"><h3 className="font-medium">{t("signatureProgress")}</h3><span className="tabular-nums">{record.proposal.signatures.length} / {account?.threshold ?? "?"}</span></div>
          {account && <progress className="safe-progress" aria-label={t("signatureProgress")} value={Math.min(record.proposal.signatures.length, account.threshold)} max={account.threshold} />}
          <div className="mt-3 space-y-2">{record.proposal.signatures.map(signature => <div key={signature.owner} className="flex items-center gap-2"><CheckCircle2 size={16} className="shrink-0 text-emerald-500" /><SafeAddress address={signature.owner} /></div>)}</div>
        </div>
        {record.transactionHash && <p className="break-all text-sm">{t("transactionHash")}: {record.transactionHash}</p>}
        <div className="flex flex-wrap gap-2">
          <button className={primaryClass} disabled={!!signReason} onClick={() => void run(() => prepareAction("sign"), "preparingSignature")}>{t("sign")}</button>
          <button className={primaryClass} disabled={!!executeReason} onClick={() => void run(() => prepareAction("execute"), "preparingExecution")}>{t("execute")}</button>
          <button className={buttonClass} onClick={downloadProposal}>{t("export")}</button>
          <button className={buttonClass} onClick={() => navigate("import", "transaction")}>{t("import")}</button>
          {record.status === "failed" && <button className={buttonClass} onClick={() => void run(async () => {
            const result = await request({ kind: "validate", proposal: record.proposal });
            if (!result.proposal) throw new Error(t("invalidResponse"));
            assertSafeProposalMatches(result.proposal, record.proposal);
            saveProposal(result.proposal, { transactionHash: undefined, status: undefined }, result.account); setAccount(result.account); setMessage(t("retryReady"));
          }, "checkingTransaction")}>{t("retryFailed")}</button>}
        </div>
        <p className="text-sm text-muted-foreground">{signReason ? `${t("sign")}: ${t(signReason)}` : t("readyToSign")}</p>
        <p className="text-sm text-muted-foreground">{executeReason ? `${t("execute")}: ${t(executeReason)}` : t("readyToExecute")}</p>
        <details><summary className="cursor-pointer text-sm">{t("exportJson")}</summary><textarea aria-label={t("exportJson")} className={`${inputClass} font-mono`} rows={8} readOnly value={JSON.stringify(record.proposal, null, 2)} /></details>
      </section>}
      {view === "import" && <div className="safe-form space-y-5">
        <p className="text-sm text-muted-foreground">{t("transactionImportHint")}</p>
        <input type="file" accept="application/json,.json" aria-label={t("importFile")} onChange={e => {
          const file = e.target.files?.[0];
          if (file) void run(async () => { setTransactionImport(undefined); if (file.size > MAX_SAFE_IMPORT_BYTES) throw new Error(t("fileTooLarge")); setExchange(await file.text()); }, "readingFile");
          e.target.value = "";
        }} />
        <textarea aria-label={t("proposalJson")} className={`${inputClass} font-mono`} rows={10} value={exchange} onChange={e => {setExchange(e.target.value);setTransactionImport(undefined);}} placeholder={t("proposalJson")} />
        <button className={primaryClass} disabled={!exchange.trim()} onClick={() => void run(importProposal, "verifyingImport")}>{t("verifyImport")}</button>
        {transactionImport&&<section className="space-y-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <h3 className="font-semibold">{t("importPreview")}</h3>
          <p className="text-sm">{t("network")}: {chain?.name} · {transactionImport.chainId}</p>
          <label className="block text-sm">{t("safeAddress")}<input className={inputClass} value={importAddress} readOnly={!!transactionImport.safeAddress} onChange={e=>setImportAddress(e.target.value)} placeholder="0x…"/></label>
          {transactionImport.transactions.length>1&&<>
            <p className="text-sm text-amber-400">{t("importSeparateTransactions")}</p>
            <label className="block text-sm">{t("selectImportedTransaction")}<select className={inputClass} value={importIndex} onChange={e=>setImportIndex(Number(e.target.value))}>
              {transactionImport.transactions.map((transaction,index)=><option key={index} value={index}>{index+1}. {transaction.to}</option>)}
            </select></label>
          </>}
          <p className="break-all text-sm">{t("recipient")}: {transactionImport.transactions[importIndex].to}</p>
          <p className="break-all text-sm">{t("amount")}: {formatUintToDecimalAmount(transactionImport.transactions[importIndex].value,18)} {chain?.native_symbol} ({transactionImport.transactions[importIndex].value} wei)</p>
          <label className="block text-sm">{t("calldata")}<textarea className={`${inputClass} font-mono`} rows={4} readOnly value={transactionImport.transactions[importIndex].data}/></label>
          <button className={primaryClass} disabled={!/^0x[0-9a-fA-F]{40}$/.test(importAddress.trim())} onClick={()=>void run(importTransaction, "creatingProposal")}>{t("propose")}</button>
        </section>}
      </div>}
    </fieldset>
  </div>;
}

function AccountSkeleton() {
  return <div className="safe-surface space-y-6" aria-hidden="true">
    <div className="safe-skeleton h-4 w-40" /><div className="safe-skeleton h-4 max-w-md" />
    <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="space-y-4 rounded-xl border border-border p-5"><div className="safe-skeleton h-3 w-20" /><div className="safe-skeleton h-8 w-28" /></div>)}</div>
    <div className="safe-skeleton h-12 w-full" />
  </div>;
}

function StatusBadge({ state, label }: { state: string; label: string }) {
  return <span className="safe-badge" data-state={state}>{["executed", "confirmed", "ready"].includes(state) ? <CheckCircle2 size={13} /> : ["failed", "stale"].includes(state) ? <XCircle size={13} /> : <Clock3 size={13} />}{label}</span>;
}

function ProposalDetails({ proposal: p, call, t, symbol }: { proposal: SafeProposal; call?: SafeCallMetadata; t: ReturnType<typeof useTranslations>; symbol?: string }) {
  const verified = verifiedSafeCall(call, p);
  return <div className="space-y-3">
    {verified ? <SafeCallSummary call={verified} t={t} /> : p.data !== "0x" && <p className="text-sm text-amber-400">{t("abiRawSummary")}</p>}
    <dl className="safe-detail-grid text-sm break-all">
    <div><dt className="text-muted-foreground">{t("safeAddress")}</dt><dd><SafeAddress address={p.safe_address} /></dd></div>
    <div><dt className="text-muted-foreground">{t("recipient")}</dt><dd><SafeAddress address={p.to} /></dd></div>
    <div><dt className="text-muted-foreground">{t("amount")}</dt><dd>{formatUintToDecimalAmount(p.value, 18)} {symbol}</dd></div>
    <div><dt className="text-muted-foreground">{t("amountWei")}</dt><dd>{p.value}</dd></div>
    <div><dt className="text-muted-foreground">Nonce</dt><dd>{p.nonce}</dd></div>
    <div><dt className="text-muted-foreground">{t("calldata")}</dt><dd className="max-h-40 overflow-auto font-mono text-xs">{p.data}</dd></div>
    <div><dt className="text-muted-foreground">Safe transaction hash</dt><dd>{p.safe_tx_hash}</dd></div>
  </dl></div>;
}
