import { useWalletActivity } from './session-activity';
import { t, useLocale } from './i18n';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Fingerprint, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { ThemeControl } from './theme';
import { WalletHome } from './wallet-home';
import { api, type WalletStatus } from './api';
import { unlockWithPasskey } from './passkey-client';

function Popup() {
  useLocale(); useWalletActivity();
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setStatus(await api<WalletStatus>({ type: 'STATUS' })); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to open wallet'); }
  }, []);
  const open = useCallback(async () => {
    try { await api({ type: 'OPEN_WALLET' }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to initialize wallet'); }
  }, [refresh]);
  useEffect(() => { void open(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [open, refresh]);
  if (status?.initialized && !status.locked) return <WalletHome status={status} refresh={refresh} />;
  return <main className="shell"><header className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><strong>FnzSafe</strong><ThemeControl /></header>
    {!status || !status.initialized ? <section className="center-state"><RefreshCw className={error ? '' : "spin"} /><h2>{error ? t("Wallet unavailable") : t("Preparing your wallet")}</h2><p>{t(error || 'Creating your first account securely on this device.')}</p>{error && <button onClick={() => void open()}>{t("Try again")}</button>}</section> : <Unlock status={status} onComplete={refresh} onResume={open} />}
  </main>;
}
function Unlock({ status, onComplete, onResume }: { status: WalletStatus; onComplete: () => Promise<void>; onResume: () => Promise<void> }) {
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (!status.passwordProtected) await onResume();
      else { const secret = status.passkey ? await unlockWithPasskey(status.passkey) : password; await api({ type: 'UNLOCK', password: secret }); await onComplete(); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to unlock wallet'); }
    finally { setBusy(false); setPassword(''); }
  }
  return <section className="onboarding"><div className="onboarding-symbol">{status.passkey ? <Fingerprint size={36} /> : <Lock size={32} />}</div><h1>{t("Welcome back")}</h1><p>{status.passkey ? t("Use your Passkey to unlock your wallet.") : status.passwordProtected ? t("Enter your password to unlock your wallet.") : t("Your default wallet is saved on this browser. Continue to protect and back it up.")}</p>
    <form onSubmit={submit}>{status.passwordProtected && !status.passkey && <label>{t("Password")}<input type="password" autoComplete="current-password" autoFocus value={password} onChange={e => setPassword(e.target.value)} required /></label>}{error && <p className="error">{t(error)}</p>}<button className="primary" disabled={busy}>{busy ? t("Unlocking…") : status.passkey ? t("Unlock with Passkey") : status.passwordProtected ? t("Unlock") : t("Continue to wallet")}</button></form>
  </section>;
}
createRoot(document.getElementById('root')!).render(<Popup />);
