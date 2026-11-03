import { t, LanguageSettings } from './i18n';
import { useState } from 'react';
import { useDialogFocus } from './dialog-focus';
import { Check, Globe2, Lock, ShieldCheck, WalletCards, X } from 'lucide-react';
import { ThemeSettings } from './theme';
import { RecoverySettings, RpcSettings } from './wallet-settings';
import { api, type WalletStatus } from './api';
import type { ChainFamily, ChainInfo } from '../types';
export function SendDialog({ accountId, family, chain, onClose, onSent }: { accountId: string; family: ChainFamily; chain: ChainInfo; onClose: () => void; onSent: () => void }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useDialogFocus<HTMLFormElement>(() => { if (!busy) onClose(); });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!confirming) return setConfirming(true);
    setBusy(true);
    try {
      const result = await api<{ signature: string }>({ type: 'SEND_NATIVE', family, recipient, amount, accountId, chainKey: chain.key });
      void result;
      onSent();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop"><form ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={t("Send native asset")} onSubmit={submit}>
    <h2>{confirming ? t("Confirm transfer") : t('Send {symbol}', { symbol: chain.symbol })}</h2>
    {confirming ? <dl><dt>{t("Network")}</dt><dd>{chain.name}</dd><dt>{t("Recipient")}</dt><dd>{recipient}</dd><dt>{t("Amount")}</dt><dd>{amount} {chain.symbol}</dd></dl> : <><label>{t("Recipient")}<input value={recipient} onChange={(event) => setRecipient(event.target.value.trim())} required /></label><label>{t("Amount")}<input type="number" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label></>}
    {error && <p className="error">{t(error)}</p>}
    <div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="primary" disabled={busy}>{busy ? t("Submitting...") : confirming ? t("Confirm") : t("Review")}</button></div>
  </form></div>;
}

export function SettingsView({ status, onLock, onRefresh }: { status: WalletStatus; onLock: () => void; onRefresh: () => Promise<void> }) {
  const [error, setError] = useState('');
  return <section className="settings-view"><div className="page-heading"><span className="eyebrow">{t("YOUR WALLET, YOUR WAY")}</span><h2>{t("Settings")}</h2><p>{t("A little more personal. Just as secure.")}</p></div><ThemeSettings /><LanguageSettings /><section className="settings-panel"><label>{t('Auto-lock after inactivity')}<select value={status.settings.autoLockMinutes} onChange={async e => { try { await api({ type: 'SET_AUTO_LOCK', minutes: Number(e.target.value) }); await onRefresh(); setError(''); } catch { setError('Unable to save auto-lock setting'); } }}>{[5,15,30,60].map(minutes => <option key={minutes} value={minutes}>{t('{minutes} minutes', { minutes })}</option>)}</select></label><p className="fine-print">{t('Clicks, typing and scrolling reset the timer. Background refreshes do not.')}</p>{error && <p className="error">{t(error)}</p>}</section><h3 className="group-label">{t("Security & privacy")}</h3><div className="settings-list">
    <button onClick={onLock}><Lock /><span><strong>{status.passwordProtected ? t("Lock wallet") : t("Protect wallet")}</strong><small>{status.passwordProtected ? t("Clear decrypted keys from memory") : t("Set up a Passkey or password")}</small></span></button>
    <div><ShieldCheck /><span><strong>{status.passkey ? t("Passkey protection") : status.passwordProtected ? t("Auto-lock") : t("Browser storage")}</strong><small>{status.passwordProtected ? t('{minutes} minutes', { minutes: status.settings.autoLockMinutes }) : t("Not protected by a Passkey or password yet")}</small></span><span className="status-dot" /></div>

    <button onClick={async () => {
      await api({ type: 'SET_ENHANCED_ASSET_DETECTION', enabled: !status.settings.enhancedAssetDetection });
      await onRefresh();
    }}><WalletCards /><span><strong>{t("Enhanced token detection")}</strong><small>{status.settings.enhancedAssetDetection ? t("On by default - public addresses may be sent to configured index services") : t("Off - native assets and manually imported tokens only")}</small></span>{status.settings.enhancedAssetDetection ? <Check /> : null}</button>
    <div><Globe2 /><span><strong>{t("Connected sites")}</strong><small>{status.connectedSites.length === 0 ? t("No sites currently authorized") : t('{count} authorized', { count: status.connectedSites.length })}</small></span></div>
    {status.connectedSites.map((site) => <button key={site.origin} onClick={async () => {
      await api({ type: 'REVOKE_PERMISSION', origin: site.origin });
      await onRefresh();
    }}><span><strong>{new URL(site.origin).hostname}</strong><small>{site.families.join(' + ').toUpperCase()} - {site.accountCount} {t("account -")} {site.networkCount} {t("network")}</small></span><X aria-label={t('Disconnect {site}', { site: new URL(site.origin).hostname })} /></button>)}
    {status.connectedSites.length > 1 && <button className="danger-action" onClick={async () => { await api({ type: 'CLEAR_PERMISSIONS' }); await onRefresh(); }}><X /><span><strong>{t("Disconnect all sites")}</strong><small>{t("Revoke every DApp connection")}</small></span></button>}
  </div><RpcSettings status={status} onRefresh={onRefresh} />{status.passwordProtected && <RecoverySettings status={status} onRefresh={onRefresh} />}</section>;
}
