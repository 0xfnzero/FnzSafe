import { t, LanguageSettings } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from './dialog-focus';
import { ArrowLeft, Check, ChevronRight, Download, FileLock2, Globe2, Link2, LoaderCircle, Lock, Palette, ShieldCheck, WalletCards, X } from 'lucide-react';
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

type SettingsPage = 'home' | 'appearance' | 'security' | 'networks' | 'privacy' | 'sites' | 'backup' | 'recovery';
export function SettingsView({ status, onLock, onRefresh, onSecurity, onManageWallets, onImport }: {
  status: WalletStatus; onLock: () => Promise<void>; onRefresh: () => Promise<void>;
  onSecurity: () => void; onManageWallets: () => void; onImport: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>('home');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const lock = useRef(false), root = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { root.current?.scrollTo({ top: 0 }); heading.current?.focus({ preventScroll: true }); }, [page]);
  function navigate(next: SettingsPage) { setError(''); setSaved(false); setPage(next); }
  async function update(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setSaved(false);
    try { await action(); await onRefresh(); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to save settings'); }
    finally { lock.current = false; setBusy(false); }
  }
  const titles: Record<SettingsPage, string> = { home: 'Settings', appearance: 'Appearance & language', security: 'Security & auto-lock', networks: 'Network RPC', privacy: 'Token detection & privacy', sites: 'Connected sites', backup: 'Export encrypted backup', recovery: 'Recovery & backup' };
  function row(icon: React.ReactNode, title: string, detail: string, action: () => void) {
    return <button onClick={action}><span className="setting-icon">{icon}</span><span><strong>{t(title)}</strong><small>{t(detail)}</small></span><ChevronRight size={16} /></button>;
  }
  return <section ref={root} className="settings-view settings-flow">
    <header className="flow-header">{page !== 'home' && <button className="icon-button" aria-label={t('Back')} disabled={busy} onClick={() => navigate(page === 'backup' ? 'recovery' : 'home')}><ArrowLeft size={20} /></button>}<div><h2 ref={heading} tabIndex={-1}>{t(titles[page])}</h2>{page === 'home' && <p>{t('Manage your wallet and preferences.')}</p>}</div></header>
    {error && <p className="error" role="alert">{t(error)}</p>}
    {busy && <div className="safe-operation" role="status"><LoaderCircle size={17} className="spin" />{t('Saving changes…')}</div>}
    {saved && <p className="success-note" role="status"><Check size={15} /> {t('Changes saved')}</p>}
    {page === 'home' && <>
      <h3 className="group-label">{t('Wallet')}</h3><div className="settings-menu">
        {row(<WalletCards />, 'Manage wallets', 'Accounts and wallet addresses', onManageWallets)}
        {row(<ShieldCheck />, status.passwordProtected ? 'Recovery & backup' : 'Protect wallet', status.passwordProtected ? 'Recovery phrase, private keys and encrypted backups' : 'Set up a Passkey or password', status.passwordProtected ? () => navigate('recovery') : onSecurity)}
        {row(<Download />, 'Import accounts', 'Recovery phrase, private key or backup file', onImport)}
      </div>
      <h3 className="group-label">{t('Preferences')}</h3><div className="settings-menu">
        {row(<Palette />, 'Appearance & language', 'Theme and display language', () => navigate('appearance'))}
        {row(<Lock />, 'Security & auto-lock', 'Protection and inactivity timer', () => navigate('security'))}
        {row(<Globe2 />, 'Network RPC', 'Manage network connections', () => navigate('networks'))}
        {row(<WalletCards />, 'Token detection & privacy', 'Control external asset discovery', () => navigate('privacy'))}
        {row(<Link2 />, 'Connected sites', t('{count} authorized', { count: status.connectedSites.length }), () => navigate('sites'))}
      </div>
    </>}
    {page === 'recovery' && <div className="settings-menu">{row(<ShieldCheck />, 'Backup & export', 'Recovery phrase and private keys', onSecurity)}{row(<FileLock2 />, 'Export encrypted backup', 'Save all accounts in a protected file', () => navigate('backup'))}</div>}
    {page === 'appearance' && <><ThemeSettings /><LanguageSettings /></>}
    {page === 'security' && <>
      <div className="settings-panel"><div className="protection-status"><ShieldCheck size={24} /><div><strong>{status.passkey ? t('Passkey protection') : status.passwordProtected ? t('Password protection') : t('Protect wallet')}</strong><p>{status.passwordProtected ? t('Your wallet is protected.') : t('Not protected by a Passkey or password yet')}</p></div></div><button className="secondary-wide" onClick={onSecurity}>{status.passwordProtected ? t('Backup & export') : t('Set up a Passkey or password')}</button></div>
      <fieldset className="safe-controls" disabled={busy}><section className="settings-panel"><label>{t('Auto-lock after inactivity')}<select value={status.settings.autoLockMinutes} onChange={e => { const minutes = Number(e.target.value); void update(async () => { await api({ type: 'SET_AUTO_LOCK', minutes }); }); }}>{[5,15,30,60].map(minutes => <option key={minutes} value={minutes}>{t('{minutes} minutes', { minutes })}</option>)}</select></label><p className="fine-print">{t('Clicks, typing and scrolling reset the timer. Background refreshes do not.')}</p></section>
      {status.passwordProtected && <button className="secondary-wide" onClick={() => void update(onLock)}><Lock size={17} />{t('Lock wallet')}</button>}</fieldset>
    </>}
    {page === 'networks' && <RpcSettings status={status} onRefresh={onRefresh} onBusyChange={setBusy} />}
    {page === 'privacy' && <section className="settings-panel"><div className="setting-toggle"><div><h3>{t('Enhanced token detection')}</h3><p className="fine-print">{status.settings.enhancedAssetDetection ? t('On by default - public addresses may be sent to configured index services') : t('Off - native assets and manually imported tokens only')}</p></div><button role="switch" aria-checked={status.settings.enhancedAssetDetection} aria-label={t('Enhanced token detection')} className="toggle-switch" disabled={busy} onClick={() => void update(async () => { await api({ type: 'SET_ENHANCED_ASSET_DETECTION', enabled: !status.settings.enhancedAssetDetection }); })}><span /></button></div></section>}
    {page === 'sites' && <fieldset className="safe-controls" disabled={busy}>
      {status.connectedSites.length === 0 ? <div className="empty"><Link2 size={28} /><strong>{t('No sites currently authorized')}</strong><span>{t('Connected DApps will appear here.')}</span></div> : <><p className="fine-print">{t('Disconnect a site to revoke its access to your accounts.')}</p><div className="connected-site-list">{status.connectedSites.map(site => <div key={site.origin}><Globe2 size={20} /><span><strong>{new URL(site.origin).hostname}</strong><small>{site.families.join(' + ').toUpperCase()} · {t('{count} accounts', { count: site.accountCount })}</small></span><button className="icon-button" aria-label={t('Disconnect {site}', { site: new URL(site.origin).hostname })} onClick={() => void update(async () => { await api({ type: 'REVOKE_PERMISSION', origin: site.origin }); })}><X size={17} /></button></div>)}</div>{status.connectedSites.length > 1 && <button className="secondary-wide danger-action" onClick={() => void update(async () => { await api({ type: 'CLEAR_PERMISSIONS' }); })}>{t('Disconnect all sites')}</button>}</>}
    </fieldset>}
    {page === 'backup' && status.passwordProtected && <RecoverySettings status={status} onRefresh={onRefresh} initialMode="export" onBusyChange={setBusy} onClose={() => navigate('recovery')} />}
  </section>;
}
