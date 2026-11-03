import { t } from './i18n';
import { ShieldCheck, FileSignature } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatUnits, parseUnits } from 'ethers';
import type { SafeAccount, SafeProposal } from '../safe';
import { api, compact } from './api';
import { ReviewDialog, type TransactionReview } from './transactions';

export function SafeView({ chainId, accountId }: { chainId: number; accountId?: string }) {
  const [workspace, setWorkspace] = useState<{ safes: Array<{ chainId: number; address: string }>; proposals: SafeProposal[] }>({ safes: [], proposals: [] });
  const [address, setAddress] = useState(''), [account, setAccount] = useState<SafeAccount | null>(null);
  const [owners, setOwners] = useState(''), [threshold, setThreshold] = useState('2');
  const [to, setTo] = useState(''), [amount, setAmount] = useState('0'), [data, setData] = useState('0x'), [nonce, setNonce] = useState('');
  const [importText, setImportText] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [review, setReview] = useState<TransactionReview | null>(null);
  async function load() { setWorkspace(await api({ type: 'SAFE_LIST' })); }
  useEffect(() => { setAccount(null); setAddress(''); setReview(null); setMessage(''); void load().catch(() => setMessage('Unable to load saved Safes')); }, [chainId, accountId]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); await load(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Safe operation failed'); }
    finally { setBusy(false); }
  }
  async function openSafe(value: string) { const info = await api<SafeAccount>({ type: 'SAFE_ACCOUNT', address: value }); setAddress(info.address); setAccount(info); setNonce(info.nonce); }
  const proposals = workspace.proposals.filter(p => p.chain_id === chainId && (!account || p.safe_address.toLowerCase() === account.address.toLowerCase()));
  return <section className="safe-view"><div className="safe-intro"><ShieldCheck size={28} /><h2>{t("Shared control.")}</h2><p>{t("Create a Safe or manage an existing multisig wallet. Transactions need approval from multiple owners.")}</p></div><span className="eyebrow">{t("SAFE MULTISIG · EVM")}</span>
    <form onSubmit={e => { e.preventDefault(); void run(() => openSafe(address)); }}><label>{t("Safe address")}<input value={address} onChange={e => { setAddress(e.target.value); setAccount(null); }} required /></label><button disabled={busy}>{t("Open Safe")}</button></form>
    <div className="saved-safes">{workspace.safes.filter(s => s.chainId === chainId).map(s => <button key={s.address} disabled={busy} onClick={() => void run(() => openSafe(s.address))}>{compact(s.address)}</button>)}</div>
    <details className="settings-panel"><summary>{t("Create Safe")}</summary><form onSubmit={e => { e.preventDefault(); void run(async () => {
      setReview(await api({ type: 'SAFE_PREPARE_CREATE', owners: owners.split(/[\s,;]+/).filter(Boolean), threshold: Number(threshold), salt: BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')).toString() }));
    }); }}><label>{t("Owner addresses")}<textarea value={owners} onChange={e => setOwners(e.target.value)} rows={3} required /></label><label>{t("Required signatures")}<input type="number" min={2} max={50} value={threshold} onChange={e => setThreshold(e.target.value)} required /></label><button disabled={busy}>{t("Preview Safe creation")}</button></form></details>
    {account && <><div className="settings-panel"><h3>{t("Safe account")}</h3><code>{account.address}</code><p>{account.threshold} {t("of")} {account.owners.length} {t("signatures · nonce")} {account.nonce}</p><p>{t("Balance:")} {formatUnits(account.balance_wei, 18)} {t("native")}</p>{account.owners.map(owner => <code className="owner-address" key={owner}>{owner}</code>)}</div>
      <details className="settings-panel"><summary>{t("New proposal")}</summary><form onSubmit={e => { e.preventDefault(); void run(async () => {
        await api({ type: 'SAFE_PROPOSE', address: account.address, to, value: parseUnits(amount, 18).toString(), data, nonce }); setMessage('Proposal saved. Review it below before signing.');
      }); }}><label>{t("Recipient / contract")}<input value={to} onChange={e => setTo(e.target.value)} required /></label><label>{t("Native amount")}<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label><label>{t("Calldata (hex)")}<textarea value={data} onChange={e => setData(e.target.value)} maxLength={131074} required /></label><label>{t("Safe nonce")}<input inputMode="numeric" value={nonce} onChange={e => setNonce(e.target.value)} required /></label><p className="fine-print">{t("Use 0x for a native transfer. Contract calls require the exact ABI-encoded calldata. Operation is always CALL; gas refunds are disabled.")}</p><button disabled={busy}>{t("Save proposal")}</button></form></details>
    </>}
    <details className="settings-panel"><summary>{t("Import / merge signed proposal")}</summary><form onSubmit={e => { e.preventDefault(); void run(async () => { await api({ type: 'SAFE_IMPORT', proposal: importText }); setImportText(''); setMessage('Proposal validated and merged'); }); }}><label>{t("Proposal JSON")}<textarea rows={4} maxLength={180000} value={importText} onChange={e => setImportText(e.target.value)} required /></label><label>{t("Proposal file")}<input type="file" accept=".json" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 180000) return setMessage('Proposal exceeds size limit'); setImportText(await file.text()); }} /></label><button disabled={busy}>{t("Validate & import")}</button></form></details>
    {message && <p role="status" className="asset-warning">{t(message)}</p>}
    <h3 className="group-label">{t("Proposals")}</h3>{!proposals.length && <div className="empty"><FileSignature size={28} /><strong>{t("All clear for now")}</strong><span>{t("Your shared transactions will appear here.")}</span></div>}
    {proposals.map(p => <article className="settings-panel" key={p.safe_tx_hash}><strong>{t("Nonce")} {p.nonce} · {p.signatures.length} {t("signatures")}</strong><p>{t("To:")} <code>{p.to}</code></p><p>{t("Value:")} {formatUnits(p.value, 18)} {t("native")}</p><details><summary>{t("Full proposal")}</summary><pre className="review-data">{JSON.stringify(p, null, 2)}</pre></details><div className="proposal-actions">
      <button disabled={busy} onClick={() => void run(async () => setReview(await api({ type: 'SAFE_PREPARE_SIGN', proposal: JSON.stringify(p) })))}>{t("Review & sign")}</button>
      <button disabled={busy} onClick={() => void run(async () => setReview(await api({ type: 'SAFE_PREPARE_EXECUTE', proposal: JSON.stringify(p) })))}>{t("Preview execution")}</button>
      <button onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `safe-${p.nonce}-${p.safe_tx_hash.slice(2, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }}>{t("Export JSON")}</button>
    </div></article>)}
    {review && <ReviewDialog review={review} onClose={() => setReview(null)} onDone={async result => { setReview(null); await load(); setMessage(result.hash ? `Submitted: ${result.hash}. Check the receipt in Activity.` : 'Signature added. Export the proposal to share it.'); }} />}
  </section>;
}
