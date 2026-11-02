"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { SafeAddress as CopyAddress } from "./SafeAddress";
import { useTranslations } from "@/hooks/useTranslations";
import { formatUintToDecimalAmount, isValidEvmAddress } from "@/lib/evmAbi";
import { validateSafeCreation } from "@/lib/safeMultisig";
import type { EvmContractChainConfig, EvmContractSavedWallet } from "./EvmContractInvokePanel";

export interface SafeOwnerDraft { id: number; name: string; address: string }
export interface SafeCreationDraft { label: string; owners: SafeOwnerDraft[]; threshold: number }
export interface SafeCreationPreview { address: string; estimatedFee: string }
export const emptySafeCreation = (): SafeCreationDraft => ({
  label: "", owners: [{ id: 1, name: "", address: "" }, { id: 2, name: "", address: "" }], threshold: 2,
});
const field = "w-full min-w-0 rounded-xl border border-border bg-background px-3 py-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-50";
const secondary = "inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40";
const primary = `${secondary.replace("hover:bg-muted", "")} border-transparent bg-emerald-500 text-black hover:bg-emerald-400`;
const card = "min-w-0 rounded-2xl border border-border bg-card";

export function SafeCreateWizard({ chains, chainId, wallets, walletId, draft, preview, busy, onDraftChange, onChainChange, onWalletChange, onPrepare, onEdit, onConfirm, onCancel }: {
  chains: EvmContractChainConfig[]; chainId: number; wallets: EvmContractSavedWallet[]; walletId: string;
  draft: SafeCreationDraft; preview?: SafeCreationPreview; busy: boolean;
  onDraftChange: (draft: SafeCreationDraft) => void; onChainChange: (chainId: number) => void;
  onWalletChange: (walletId: string) => void; onPrepare: () => void; onEdit: () => void;
  onConfirm: () => void; onCancel: () => void;
}) {
  const translate = useTranslations();
  const t = (key: string, vars?: Record<string, string | number>) => translate(`features.safe-multisig.${key}`, vars);
  const [editingStep, setEditingStep] = useState<1 | 2>(1);
  const step = preview ? 3 : editingStep;
  const heading = useRef<HTMLHeadingElement>(null);
  const chain = chains.find(c => c.chain_id === chainId);
  const wallet = wallets.find(w => w.id === walletId && w.evm_address);
  const error = validateSafeCreation(draft.owners.map(o => o.address.trim()).join("\n"), String(draft.threshold));
  const ownersComplete = draft.owners.every(o => o.address.trim());
  const validBasics = !!draft.label.trim() && !!chain && !!wallet;
  const steps = ["setupBasics", "setupSigners", "setupReview"];
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [step]);
  function updateOwner(id: number, change: Partial<SafeOwnerDraft>) {
    onDraftChange({ ...draft, owners: draft.owners.map(o => o.id === id ? { ...o, ...change } : o) });
  }
  function goBack() {
    if (preview) { onEdit(); setEditingStep(2); }
    else if (step === 2) setEditingStep(1);
    else onCancel();
  }
  return <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.45fr)]">
    <section className={`${card} overflow-hidden`} aria-label={t("create")}>
      <ol aria-label={t("creationSteps")} className="grid grid-cols-3 border-b border-border">
        {steps.map((key, index) => <li key={key} aria-current={step === index + 1 ? "step" : undefined}
          className={`flex items-center gap-2 border-t-4 px-3 py-4 text-xs sm:px-5 ${step >= index + 1 ? "border-emerald-500" : "border-transparent text-muted-foreground"}`}>
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${step >= index + 1 ? "bg-emerald-500 text-black" : "bg-muted"}`}>
            {step > index + 1 ? <Check size={14} aria-hidden="true" /> : index + 1}
          </span><span>{t(key)}</span>
        </li>)}
      </ol>
      <header className="space-y-2 border-b border-border p-5 sm:p-7">
        <h3 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">{t(steps[step - 1])}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{t(["basicsHelp", "signersHelp", "reviewHelp"][step - 1])}</p>
      </header>
      <div className="space-y-6 p-5 sm:p-7">
        {step === 1 && <>
          <label className="block space-y-2 text-sm font-medium">{t("label")}<input className={field} value={draft.label} maxLength={100}
            placeholder={t("namePlaceholder")} onChange={e => onDraftChange({ ...draft, label: e.target.value })} /></label>
          <label className="block space-y-2 text-sm font-medium">{t("network")}<select className={field} value={chainId} onChange={e => onChainChange(Number(e.target.value))}>
            {!chain && <option value={chainId}>{t("selectNetwork")}</option>}
            {chains.map(c => <option key={c.chain_id} value={c.chain_id}>{c.name} · {c.chain_id} · {t(c.testnet ? "testnet" : "mainnet")}</option>)}
          </select></label>
          <p className="text-sm text-muted-foreground">{t("oneNetworkHint")}</p>
          <label className="block space-y-2 text-sm font-medium">{t("gasWallet")}<select className={field} value={walletId} onChange={e => onWalletChange(e.target.value)}>
            <option value="">{t("selectWallet")}</option>
            {wallets.filter(w => w.evm_address).map(w => <option key={w.id} value={w.id}>{w.name} · {w.evm_address}</option>)}
          </select></label>
          <p className="text-sm text-muted-foreground">{t("payerHint")}</p>
        </>}
        {step === 2 && <>
          <div className="space-y-4">
            {draft.owners.map((owner, index) => {
              const address = owner.address.trim();
              const invalid = !!address && (!isValidEvmAddress(address) || /^0x0{39}[01]$/i.test(address));
              const duplicate = !!address && draft.owners.some(other => other.id !== owner.id && other.address.trim().toLowerCase() === address.toLowerCase());
              const rowError = invalid ? "invalidOwnerAddress" : duplicate ? "duplicateOwners" : undefined;
              const savedWallet = wallets.find(w => w.evm_address?.toLowerCase() === address.toLowerCase());
              return <div key={owner.id} className="space-y-3 rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium"><UserRound size={16} aria-hidden="true" />{t("signerNumber", { number: index + 1 })}</span>
                  <button type="button" className="rounded-lg p-2 text-muted-foreground hover:bg-muted disabled:opacity-30" disabled={draft.owners.length <= 2}
                    aria-label={t("removeSigner", { number: index + 1 })} onClick={() => onDraftChange({ ...draft, owners: draft.owners.filter(o => o.id !== owner.id), threshold: Math.min(draft.threshold, draft.owners.length - 1) })}><Trash2 size={16} /></button>
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,0.65fr)_minmax(0,1fr)]">
                  <label className="space-y-2 text-xs text-muted-foreground">{t("signerName")}<input className={field} aria-label={t("signerNameNumber", { number: index + 1 })} value={owner.name} maxLength={100}
                    placeholder={t("optionalName")} onChange={e => updateOwner(owner.id, { name: e.target.value })} /></label>
                  <label className="space-y-2 text-xs text-muted-foreground">{t("savedWallet")}<select className={field} value={savedWallet?.id || ""} aria-label={t("chooseSignerNumber", { number: index + 1 })}
                    onChange={e => { const selected = wallets.find(w => w.id === e.target.value); if (selected?.evm_address) updateOwner(owner.id, { address: selected.evm_address, name: !owner.name || owner.name === savedWallet?.name ? selected.name : owner.name }); else updateOwner(owner.id, { address: "" }); }}>
                    <option value="">{t("manualAddress")}</option>
                    {wallets.filter(w => w.evm_address).map(w => <option key={w.id} value={w.id} disabled={draft.owners.some(o => o.id !== owner.id && o.address.trim().toLowerCase() === w.evm_address!.toLowerCase())}>{w.name} · {w.evm_address!.slice(0, 8)}…{w.evm_address!.slice(-6)}</option>)}
                  </select></label>
                </div>
                <label className="block space-y-2 text-xs text-muted-foreground">{t("signerAddress")}<input className={`${field} font-mono`} spellCheck={false} autoComplete="off"
                  aria-label={t("signerAddressNumber", { number: index + 1 })} aria-invalid={!!rowError} aria-describedby={rowError ? `safe-owner-${owner.id}-error` : undefined}
                  placeholder="0x…" value={owner.address} onChange={e => updateOwner(owner.id, { address: e.target.value })} /></label>
                {rowError && <p id={`safe-owner-${owner.id}-error`} className="text-xs text-red-400">{t(rowError)}</p>}
                {address && address.toLowerCase() === wallet?.evm_address?.toLowerCase() && <p className="text-xs text-emerald-500">{t("selectedPayer")}</p>}
              </div>;
            })}
          </div>
          <button className={secondary} disabled={draft.owners.length >= 50} onClick={() => onDraftChange({ ...draft, owners: [...draft.owners, { id: Math.max(...draft.owners.map(o => o.id)) + 1, name: "", address: "" }] })}><Plus size={16} />{t("addOwner")}</button>
          <div className="space-y-3 border-t border-border pt-6">
            <h4 className="font-semibold">{t("threshold")}</h4>
            <p className="text-sm text-muted-foreground">{t("thresholdHelp")}</p>
            <div className="flex flex-wrap items-center gap-3"><select aria-label={t("threshold")} className={`${field} !w-20`} value={draft.threshold}
              onChange={e => onDraftChange({ ...draft, threshold: Number(e.target.value) })}>
              {Array.from({ length: draft.owners.length - 1 }, (_, i) => i + 2).map(n => <option key={n} value={n}>{n}</option>)}
            </select><span className="text-sm">{t("outOfSigners", { count: draft.owners.length })}</span></div>
            <p className="text-xs text-muted-foreground">{t("minimumSigners")}</p>
          </div>
        </>}
        {step === 3 && preview && <>
          <dl className="grid gap-5 text-sm sm:grid-cols-[120px_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{t("network")}</dt><dd>{chain?.name} · {chainId} <span className="ml-2 rounded-md bg-muted px-2 py-1 text-xs">{t(chain?.testnet ? "testnet" : "mainnet")}</span></dd>
            <dt className="text-muted-foreground">{t("label")}</dt><dd className="break-words font-medium">{draft.label}</dd>
            <dt className="text-muted-foreground">{t("setupSigners")}</dt><dd className="space-y-4">{draft.owners.map((o, i) => <div key={o.id} className="space-y-1">
              <p className="font-medium">{o.name || t("signerNumber", { number: i + 1 })}</p><CopyAddress address={o.address.trim()} /></div>)}</dd>
            <dt className="text-muted-foreground">{t("threshold")}</dt><dd>{t("thresholdSummary", { threshold: draft.threshold, count: draft.owners.length })}</dd>
            <dt className="text-muted-foreground">{t("predictedAddress")}</dt><dd><CopyAddress address={preview.address} /><p className="mt-2 text-xs text-muted-foreground">{t("predictedHint")}</p></dd>
          </dl>
          <div className="space-y-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
            <h4 className="font-semibold">{t("networkFee")}</h4>
            <p className="text-xl font-semibold">{formatUintToDecimalAmount(preview.estimatedFee, 18)} {chain?.native_symbol}</p>
            <p className="text-xs text-muted-foreground">{t("estimatedFee")}</p>
            <p className="text-sm text-muted-foreground">{t("feeHelp")}</p>
          </div>
          <p className="text-sm text-muted-foreground">{t("unlockHint")}</p>
        </>}
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-border p-5 sm:px-7">
        <button className={secondary} disabled={busy} onClick={goBack}><ArrowLeft size={16} />{t(step === 1 ? "cancel" : "back")}</button>
        {step === 1 && <button className={primary} disabled={!validBasics || busy} onClick={() => setEditingStep(2)}>{t("next")}<ArrowRight size={16} /></button>}
        {step === 2 && <button className={primary} disabled={!validBasics || !ownersComplete || !!error || busy} onClick={onPrepare}>{t(busy ? "estimating" : "reviewAndEstimate")}<ArrowRight size={16} /></button>}
        {step === 3 && <button className={primary} disabled={busy} onClick={onConfirm}>{t("confirmCreate")}</button>}
      </footer>
    </section>
    <aside className="space-y-4 xl:sticky xl:top-4" aria-label={t("accountPreview")}>
      <section className={card}>
        <header className="flex items-center gap-3 border-b border-border p-5"><ShieldCheck size={24} className="text-emerald-500" /><h3 className="font-semibold">{t("accountPreview")}</h3></header>
        <dl className="space-y-5 p-5 text-sm">
          <div className="space-y-1"><dt className="text-muted-foreground">{t("gasWallet")}</dt><dd className="font-medium">{wallet?.name || t("selectWallet")}</dd>{wallet?.evm_address && <dd className="break-all font-mono text-xs text-muted-foreground">{wallet.evm_address}</dd>}</div>
          <div className="space-y-1"><dt className="text-muted-foreground">{t("label")}</dt><dd className="break-words font-medium">{draft.label || t("unnamedSafe")}</dd></div>
          <div className="space-y-1"><dt className="text-muted-foreground">{t("network")}</dt><dd>{chain?.name || t("selectNetwork")}{chain && <span className={`ml-2 rounded-md px-2 py-1 text-xs ${chain.testnet ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-muted"}`}>{t(chain.testnet ? "testnet" : "mainnet")}</span>}</dd></div>
          <div className="space-y-1"><dt className="text-muted-foreground">{t("threshold")}</dt><dd>{t("thresholdSummary", { threshold: draft.threshold, count: draft.owners.length })}</dd></div>
        </dl>
      </section>
      <section className="space-y-4 rounded-2xl border border-sky-500/25 bg-sky-500/5 p-5 text-sm">
        <details open><summary className="cursor-pointer font-medium">{t("networkFee")}</summary><p className="mt-2 leading-relaxed text-muted-foreground">{t("feePreviewHint")}</p></details>
        <details><summary className="cursor-pointer font-medium">{t("localNames")}</summary><p className="mt-2 leading-relaxed text-muted-foreground">{t("localNamesHint")}</p></details>
      </section>
    </aside>
  </div>;
}

