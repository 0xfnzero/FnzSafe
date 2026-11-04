import { useWalletActivity } from './session-activity';
import { t, useLocale } from './i18n';
import { unlockWithPasskey } from './passkey-client';
import type { WalletStatus } from './api';
import { ThemeControl } from './theme';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, ChevronDown, LoaderCircle, Lock, ShieldCheck, X } from 'lucide-react';
import type { ApprovalView } from '../types';
import { api } from './api';

function Approval() {
  useLocale(); useWalletActivity();
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const [view, setView] = useState<ApprovalView | null>(null);
  const [password, setPassword] = useState('');
  const [walletStatus, setWalletStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);

  useEffect(() => {
    void api<WalletStatus>({ type: 'STATUS' }).then(setWalletStatus).catch(() => undefined);
    void api<ApprovalView>({ type: 'GET_PENDING', id })
      .then(setView)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const timer = setInterval(() => { void api<{ locked: boolean }>({ type: 'SESSION_STATUS' }).then(status => { if (status.locked) setView(previous => previous ? { ...previous, locked: true } : previous); }); }, 15000);
    return () => clearInterval(timer);
  }, [id]);

  async function decide(approved: boolean) {
    setBusy(true);
    try {
      if (approved && view?.locked) {
        const authorization = walletStatus?.passkey ? await unlockWithPasskey(walletStatus.passkey) : password;
        await api({ type: 'UNLOCK', password: authorization });
        setPassword('');
        setView(await api<ApprovalView>({ type: 'GET_PENDING', id }));
        setRiskAcknowledged(false);
        setBusy(false);
        return;
      }
      await api({ type: 'RESOLVE_PENDING', id, approved });
      window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      setPassword('');
    }
  }

  return <main className="approval-shell">
    <header className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><strong>FnzSafe<span className="brand-caption">{t("SECURE CONFIRMATION")}</span></strong><ThemeControl /></header>
    {!view ? <section className="center-state" aria-live="polite">{error ? <><X /><p className="error">{t(error)}</p></> : <><LoaderCircle className="spin" size={24} /><p>{t("Loading request...")}</p></>}</section> : <>
      <div className="approval-content">
        <section className="approval-heading"><span className="site-icon" aria-hidden="true">{new URL(view.origin).hostname.slice(0, 1).toUpperCase()}</span><div><p>{new URL(view.origin).hostname}</p><h1>{t(view.summary)}</h1></div></section>
        <section className="request-details">{view.details.filter(detail => detail.label !== 'Full request parameters').map((detail, index) => <div className={`request-detail${detail.label === 'Message to sign' ? ' request-message' : detail.label === 'Signing account' ? ' request-account' : ''}`} key={`${detail.label}-${index}`}><span>{t(detail.label)}</span><strong dir="auto">{detail.value}</strong></div>)}</section>
        {view.details.filter(detail => detail.label === 'Full request parameters').map((detail, index) => <details className="request-raw" key={index} open={!view.details.some(item => item.label === 'Message to sign')}><summary><span>{t(detail.label)}</span><ChevronDown size={16} aria-hidden="true" /></summary><pre tabIndex={0} aria-label={t(detail.label)}>{detail.value}</pre></details>)}
        {view.warnings.length > 0 && <section className="approval-warnings">{view.warnings.map((warning, index) => <div className="warning" key={index}><AlertTriangle size={17} aria-hidden="true" /><span>{t(warning)}</span></div>)}</section>}
        {view.locked && !walletStatus?.passkey && <label className="unlock-field"><span><Lock size={16} /> {t("Unlock to approve")}</span><input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>}
        {error && <p className="error panel-error" role="alert">{t(error)}</p>}
      </div>
      <footer className="approval-actions">
        {!view.locked && view.warnings.length > 0 && <label className="approval-risk-check"><input type="checkbox" checked={riskAcknowledged} disabled={busy} onChange={event => setRiskAcknowledged(event.target.checked)} /><span>{t('I have reviewed and understand the risks above.')}</span></label>}
        <div className="approval-action-buttons"><button disabled={busy} onClick={() => void decide(false)}>{t("Reject")}</button><button className="primary" disabled={busy || view.blocking || (!view.locked && view.warnings.length > 0 && !riskAcknowledged) || (view.locked && !walletStatus?.passkey && !password)} onClick={() => void decide(true)}>{busy && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{busy ? t("Processing...") : view.blocking ? t("Blocked") : view.locked ? walletStatus?.passkey ? t("Passkey & review") : t("Unlock & review") : t("Approve")}</button></div>
      </footer>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Approval />);
