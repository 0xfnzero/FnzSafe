import { useState } from 'react';
import { ArrowLeft, Fingerprint, KeyRound } from 'lucide-react';
import { api, type WalletStatus } from './api';
import { createWalletPasskey } from './passkey-client';
import { BackupManager } from './backup-manager';
import { t } from './i18n';

export function WalletSecurity({ status, onDone, onClose }: { status: WalletStatus; onDone: () => Promise<void>; onClose: () => void }) {
  const [method, setMethod] = useState<'passkey' | 'password'>('passkey');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (method === 'passkey') {
        const result = await createWalletPasskey();
        await api({ type: 'PROTECT_DEFAULT_WALLET', password: result.password, passkey: result.config });
      } else {
        if (password !== confirm) throw new Error('Passwords do not match');
        await api({ type: 'PROTECT_DEFAULT_WALLET', password });
      }
      await onDone(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to protect wallet'); }
    finally { setBusy(false); setPassword(''); setConfirm(''); }
  }
  if (status.passwordProtected) return <BackupManager status={status} onDone={onDone} onClose={onClose} />;
  return <section className="security-page"><header className="page-bar"><button className="icon-button" aria-label={t('Back')} disabled={busy} onClick={onClose}><ArrowLeft size={21} /></button><h2>{t('Protect your wallet')}</h2></header>
    <div className="security-symbol">{method === 'passkey' ? <Fingerprint size={34} /> : <KeyRound size={32} />}</div><p>{t('Your wallet is ready. Add protection now. You can back up later in Settings.')}</p>
    <div className="protection-choices"><button className={method === 'passkey' ? 'selected' : ''} onClick={() => setMethod('passkey')}><Fingerprint /><span><strong>Passkey</strong><small>{t('Unlock with your device. No wallet password.')}</small></span></button><button className={method === 'password' ? 'selected' : ''} onClick={() => setMethod('password')}><KeyRound /><span><strong>{t('Password')}</strong><small>{t('Protect with a password you remember.')}</small></span></button></div>
    <form onSubmit={submit}>{method === 'password' && <><label>{t('New password')}<input type="password" minLength={10} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><label>{t('Confirm password')}<input type="password" minLength={10} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required /></label></>}
      {method === 'passkey' && <p className="fine-print">{t('Requires a Passkey provider that supports encrypted wallets (PRF). Your browser will ask you to create and verify it. Keep your recovery phrase even if your Passkey syncs.')}</p>}
      <button className="primary" disabled={busy}>{t(busy ? 'Verifying…' : method === 'passkey' ? 'Set up Passkey' : 'Set password')}</button></form>
    {error && <p role="alert" className="error">{t(error)}</p>}
  </section>;
}
