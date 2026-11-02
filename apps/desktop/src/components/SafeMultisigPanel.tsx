"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const inputClass = "w-full rounded-lg border border-white/15 bg-black/20 p-2 text-sm";
const buttonClass = "aria-pressed:border-emerald-400 aria-pressed:bg-emerald-500/10 rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";

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
    return service({ chain, walletId: wallet?.id || "", walletAddress: wallet?.evm_address || "", command, approved, maxFeeWei });
  }, [chain, wallet, service, t]);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    reviewTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  function changeNetwork(next: number, creating = false) {
    setChainId(next); setAccount(undefined); setRecord(undefined); setAddress(""); setAutoReceipt(undefined);
    setReview(undefined); setError(""); setMessage(""); setExchange(""); setTransactionImport(undefined); setView(creating ? "create" : "accounts");
  }
  async function query(target: string, stay = false) {
    const result = await request({ kind: "account", address: target });
    if (!result.account) throw new Error(t("invalidResponse"));
    const same = account?.address.toLowerCase() === result.account.address.toLowerCase();
    setAccount(result.account); setAddress(result.account.address);
    if (!same) setRecord(undefined);
    if (!stay) { setView("account"); setBackView("accounts"); }
    const old = workspaceRef.current.safes.find(s => s.chainId === chainId && s.address.toLowerCase() === result.account!.address.toLowerCase());
    saveSafe({ ...old, chainId, address: result.account.address, label: old?.label || "", owners: result.account.owners });
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
    setReview(undefined);
    const result = await request(current.command, true, current.result.estimated_fee_wei);
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
    let cancelled = false;
    let attempts = 0;
    let inFlight = false;
    const timer = setInterval(() => {
      if (lock.current || inFlight || ++attempts > 20) { if (attempts > 20) clearInterval(timer); return; }
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
  const primaryClass = `${buttonClass} bg-emerald-500 text-black font-semibold`;
  async function openSafe(safe: SafeRecord) {
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
  return <div className="space-y-5">
    {view !== "create" && <fieldset disabled={blocked || !storageReady} className="grid gap-3 md:grid-cols-2">
      <label className="space-y-1 text-sm">{t("network")}
        <select className={inputClass} value={chainId} onChange={e => changeNetwork(Number(e.target.value))}>
          {!chain && <option value={chainId}>{t("selectNetwork")}</option>}
          {chains.map(c => <option key={c.chain_id} value={c.chain_id}>{c.name} · {c.chain_id} · {c.testnet ? t("testnet") : t("mainnet")}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm">{t("signer")}
        <select className={inputClass} value={walletId} onChange={e => setWalletId(e.target.value)}>
          <option value="">{t("selectWallet")}</option>
          {wallets.filter(w => w.evm_address).map(w => <option key={w.id} value={w.id}>{w.name} · {w.evm_address}</option>)}
        </select>
      </label>
    </fieldset>}
    <nav aria-label={t("navigation")} className="flex flex-wrap items-center gap-2 text-sm">
      <button disabled={blocked || view === "accounts"} onClick={() => navigate("accounts")}>{t("accounts")}</button>
      {(["account", "propose", "transaction"].includes(view) || (view === "import" && backView !== "accounts")) && <><span>/</span><button disabled={blocked || view === "account"} onClick={() => navigate("account")}>{safeTitle}</button></>}
      {view === "import" && backView === "transaction" && <><span>/</span><button disabled={blocked} onClick={() => navigate("transaction")}>{t("transactionDetails")}</button></>}
      {!["accounts", "account"].includes(view) && <><span>/</span><span aria-current="page">{t(titles[view])}</span></>}
    </nav>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">{view === "account" ? safeTitle : t(titles[view])}</h2>
      {view !== "accounts" && view !== "create" && <button disabled={blocked} className={buttonClass} onClick={() => navigate(backView)}>{t("back")}</button>}
    </div>
    {!chain && <p role="status" className="text-sm text-amber-400">{t("networksLoading")}</p>}
    {wallets.filter(w => w.evm_address).length === 0 && <p className="text-sm text-amber-400">{t("noWallets")}</p>}
    {storageError && <div role="alert" className="rounded-lg border border-amber-400/40 p-3 text-sm">{storageError}</div>}
    <div ref={feedbackRef} aria-live="polite">
      {error && <div role="alert" className="rounded-lg border border-red-400/40 p-3 text-sm text-red-400 break-words">{error}</div>}
      {message && <div role="status" className="rounded-lg border border-emerald-400/30 p-3 text-sm break-all">{message}</div>}
      {busy && <p role="status" className="text-sm">{t("working")}</p>}
    </div>
    {review && review.command.kind !== "create" && <dialog ref={dialogRef} aria-label={t("review")} onCancel={e => { e.preventDefault(); if (!busy) setReview(undefined); }} className="m-auto max-h-[85vh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-xl border border-amber-400/50 bg-background p-5 text-foreground shadow-2xl backdrop:bg-black/70">
      <div className="space-y-3">
        <h3 className="font-semibold">{t("review")} · {t(review.command.kind)}</h3>
        <p>{chain?.name} ({chainId}) · {chain?.testnet ? t("testnet") : t("mainnet")}</p>
        <p className="break-all text-sm">{t("signer")}: {wallet?.evm_address}</p>
        {review.result.proposal && <ProposalDetails proposal={review.result.proposal} call={record?.call} t={t} symbol={chain?.native_symbol} />}
        {review.result.estimated_fee_wei && <p>{t("estimatedFee")}: {formatUintToDecimalAmount(review.result.estimated_fee_wei, 18)} {chain?.native_symbol}</p>}
        <p className="text-sm">{review.command.kind === "sign" ? t("signWarning") : t("gasHint")}</p>
        <div className="flex gap-2">
          <button ref={cancelRef} className={buttonClass} disabled={busy} onClick={() => setReview(undefined)}>{t("cancel")}</button>
          <button className={primaryClass} disabled={busy} onClick={() => void run(confirm)}>{t("confirm")}</button>
        </div>
      </div>
    </dialog>}
    <fieldset disabled={blocked || !storageReady || (!chain && view !== "create")} className="space-y-5">
      {view === "accounts" && <>
        <div className="flex flex-wrap gap-2">
          <button className={primaryClass} onClick={() => navigate("create")}>{t("create")}</button>
          <button className={buttonClass} onClick={() => navigate("load")}>{t("loadExisting")}</button>
          <button className={buttonClass} onClick={() => navigate("import")}>{t("import")}</button>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />{t("showAll")}</label>
        {safes.length === 0 && <p className="rounded-xl border border-dashed border-white/20 p-8 text-center text-muted-foreground">{t("noAccounts")}</p>}
        <div className="grid gap-3 lg:grid-cols-2">{safes.map(s => <div key={s.address} className="min-w-0 rounded-lg border border-white/15">
          <button type="button" className="block w-full space-y-2 rounded-t-lg p-4 text-left hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500" onClick={() => void run(() => openSafe(s))}>
            <span className="block text-base font-semibold">{s.label || t("unnamedSafe")}</span>
            <span className="block text-xs">{proposalsForSafe(workspace.proposals, chainId, s.address).length} {t("savedTransactions")}{s.creationHash && s.status !== "confirmed" ? ` · ${t(`status.${s.status || "pending"}`)}` : ""}</span>
          </button>
          <div className="px-4 pb-4"><SafeAddress address={s.address} /></div>
        </div>)}</div>
      </>}
      {view === "load" && <div className="max-w-2xl space-y-4">
        <label className="block text-sm">{t("safeAddress")}<input className={inputClass} value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" /></label>
        <button className={primaryClass} disabled={!/^0x[0-9a-fA-F]{40}$/.test(address.trim())} onClick={() => { setAutoReceipt(undefined); void run(() => query(address.trim())); }}>{t("load")}</button>
      </div>}
      {view === "create" && <SafeCreateWizard
        chains={chains} chainId={chainId} wallets={wallets} walletId={walletId} draft={creationDraft} busy={busy}
        preview={review?.command.kind === "create" ? { address: review.result.address!, estimatedFee: review.result.estimated_fee_wei! } : undefined}
        onDraftChange={next => { setCreationDraft(next); setReview(undefined); setError(""); }}
        onChainChange={next => changeNetwork(next, true)} onWalletChange={next => { setWalletId(next); setReview(undefined); }}
        onPrepare={() => void run(prepareCreate)} onEdit={() => { setReview(undefined); setError(""); }}
        onConfirm={() => void run(confirm)} onCancel={() => navigate("accounts")}
      />}
      {view === "account" && !account && selectedSafe?.creationHash && <div className="space-y-3 rounded-xl border border-white/10 p-4">
        <p>{t(`status.${selectedSafe.status || "pending"}`)}</p><SafeAddress address={selectedSafe.address} />
        <p className="break-all text-sm">{t("transactionHash")}: {selectedSafe.creationHash}</p>
        <button className={buttonClass} onClick={() => void run(() => refreshReceipt(selectedSafe))}>{t("receipt")}</button>
      </div>}
      {view === "account" && account && <>
        <div className="space-y-3 rounded-xl border border-white/10 p-4">
          <SafeAddress address={account.address} />
          <p>{t("balance")}: {formatUintToDecimalAmount(account.balance_wei, 18)} {chain?.native_symbol} · {t("threshold")}: {account.threshold}/{account.owners.length} · Nonce {account.nonce}</p>
          <details><summary className="cursor-pointer text-sm">{t("accountOwners")}</summary><ul className="mt-3 space-y-2">{account.owners.map(owner => <li key={owner} className="text-xs">{selectedSafe?.ownerLabels?.[owner.toLowerCase()] && <span className="mr-2 font-medium">{selectedSafe.ownerLabels[owner.toLowerCase()]}</span>}<span className="break-all font-mono">{owner}</span></li>)}</ul></details>
          <button className={buttonClass} onClick={() => void run(() => query(account.address, true))}>{t("refreshAccount")}</button>
        </div>
        <div className="flex flex-wrap gap-2"><button className={primaryClass} onClick={() => navigate("propose", "account")}>{t("propose")}</button><button className={buttonClass} onClick={() => navigate("import", "account")}>{t("import")}</button></div>
        <h3 className="font-semibold">{t("proposals")} ({proposals.length})</h3>
        {proposals.length === 0 && <p className="rounded-xl border border-dashed border-white/20 p-8 text-center text-muted-foreground">{t("noProposals")}</p>}
        {proposals.map(r => <button className={`${buttonClass} block w-full space-y-2 p-4 text-left`} key={r.proposal.safe_tx_hash} onClick={() => selectRecord(r)}>
          <span className="flex flex-wrap justify-between gap-2 font-medium"><span>Nonce {r.proposal.nonce} · {formatUintToDecimalAmount(r.proposal.value, 18)} {chain?.native_symbol}</span><span>{t(`transactionState.${safeProposalState(r, account)}`)}</span></span>
          <span className="block break-all font-mono text-xs opacity-70">{r.proposal.to}</span>
          <span className="block text-xs">{t("signatures")}: {r.proposal.signatures.length}/{account.threshold}</span>
        </button>)}
      </>}
      {view === "propose" && account && <div className="max-w-2xl space-y-4">
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
        <button className={primaryClass} disabled={!!transferError} onClick={() => void run(createProposal)}>{t("propose")}</button>
      </div>}
      {view === "transaction" && record && <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{txState && t(`transactionState.${txState}`)}</p><button className={buttonClass} onClick={() => void run(async () => {
          if (record.transactionHash) { await refreshReceipt(); return; }
          const result = await request({ kind: "validate", proposal: record.proposal });
          if (result.proposal) { assertSafeProposalMatches(result.proposal, record.proposal); saveProposal(result.proposal, {}, result.account); setAccount(result.account); setMessage(t("validated")); }
        })}>{t("refreshTransaction")}</button></div>
        <ProposalDetails proposal={record.proposal} call={record.call} t={t} symbol={chain?.native_symbol} />
        <p>{t("signatures")}: {record.proposal.signatures.length}/{account?.threshold ?? "?"}</p>
        {record.proposal.signatures.map(signature => <p key={signature.owner} className="break-all font-mono text-xs">✓ {signature.owner}</p>)}
        {record.transactionHash && <p className="break-all text-sm">{t("transactionHash")}: {record.transactionHash}</p>}
        <div className="flex flex-wrap gap-2">
          <button className={primaryClass} disabled={!!signReason} onClick={() => void run(() => prepareAction("sign"))}>{t("sign")}</button>
          <button className={primaryClass} disabled={!!executeReason} onClick={() => void run(() => prepareAction("execute"))}>{t("execute")}</button>
          <button className={buttonClass} onClick={downloadProposal}>{t("export")}</button>
          <button className={buttonClass} onClick={() => navigate("import", "transaction")}>{t("import")}</button>
          {record.status === "failed" && <button className={buttonClass} onClick={() => void run(async () => {
            const result = await request({ kind: "validate", proposal: record.proposal });
            if (!result.proposal) throw new Error(t("invalidResponse"));
            assertSafeProposalMatches(result.proposal, record.proposal);
            saveProposal(result.proposal, { transactionHash: undefined, status: undefined }, result.account); setAccount(result.account); setMessage(t("retryReady"));
          })}>{t("retryFailed")}</button>}
        </div>
        <p className="text-sm text-muted-foreground">{signReason ? `${t("sign")}: ${t(signReason)}` : t("readyToSign")}</p>
        <p className="text-sm text-muted-foreground">{executeReason ? `${t("execute")}: ${t(executeReason)}` : t("readyToExecute")}</p>
        <details><summary className="cursor-pointer text-sm">{t("exportJson")}</summary><textarea aria-label={t("exportJson")} className={`${inputClass} font-mono`} rows={8} readOnly value={JSON.stringify(record.proposal, null, 2)} /></details>
      </section>}
      {view === "import" && <div className="max-w-2xl space-y-4">
        <p className="text-sm text-muted-foreground">{t("transactionImportHint")}</p>
        <input type="file" accept="application/json,.json" aria-label={t("importFile")} onChange={e => {
          const file = e.target.files?.[0];
          if (file) void run(async () => { setTransactionImport(undefined); if (file.size > MAX_SAFE_IMPORT_BYTES) throw new Error(t("fileTooLarge")); setExchange(await file.text()); });
          e.target.value = "";
        }} />
        <textarea aria-label={t("proposalJson")} className={`${inputClass} font-mono`} rows={10} value={exchange} onChange={e => {setExchange(e.target.value);setTransactionImport(undefined);}} placeholder={t("proposalJson")} />
        <button className={primaryClass} disabled={!exchange.trim()} onClick={() => void run(importProposal)}>{t("verifyImport")}</button>
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
          <button className={primaryClass} disabled={!/^0x[0-9a-fA-F]{40}$/.test(importAddress.trim())} onClick={()=>void run(importTransaction)}>{t("propose")}</button>
        </section>}
      </div>}
    </fieldset>
  </div>;
}

function ProposalDetails({ proposal: p, call, t, symbol }: { proposal: SafeProposal; call?: SafeCallMetadata; t: ReturnType<typeof useTranslations>; symbol?: string }) {
  const verified = verifiedSafeCall(call, p);
  return <div className="space-y-3">
    {verified ? <SafeCallSummary call={verified} t={t} /> : p.data !== "0x" && <p className="text-sm text-amber-400">{t("abiRawSummary")}</p>}
    <dl className="space-y-2 text-sm break-all">
    <div><dt className="text-muted-foreground">{t("safeAddress")}</dt><dd><SafeAddress address={p.safe_address} /></dd></div>
    <div><dt className="text-muted-foreground">{t("recipient")}</dt><dd>{p.to}</dd></div>
    <div><dt className="text-muted-foreground">{t("amount")}</dt><dd>{formatUintToDecimalAmount(p.value, 18)} {symbol}</dd></div>
    <div><dt className="text-muted-foreground">{t("amountWei")}</dt><dd>{p.value}</dd></div>
    <div><dt className="text-muted-foreground">Nonce</dt><dd>{p.nonce}</dd></div>
    <div><dt className="text-muted-foreground">{t("calldata")}</dt><dd className="max-h-40 overflow-auto font-mono text-xs">{p.data}</dd></div>
    <div><dt className="text-muted-foreground">Safe transaction hash</dt><dd>{p.safe_tx_hash}</dd></div>
  </dl></div>;
}
