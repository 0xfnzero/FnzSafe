import { useState } from 'react';
import { ArrowLeft, Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import { api, type WalletStatus } from './api';
import { createWalletPasskey, unlockWithPasskey } from '../passkey';

export function WalletSecurity({ status, onDone, onClose }: { status: WalletStatus; onDone: () => Promise<void>; onClose: () => void }) {
  const [method, setMethod] = useState<'passkey' | 'password'>('passkey');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [phrase, setPhrase] = useState(''), [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      let authorization = password;
      if (!status.passwordProtected) {
        if (method === 'passkey') {
          const result = await createWalletPasskey(); authorization = result.password;
          await api({ type: 'PROTECT_DEFAULT_WALLET', password: authorization, passkey: result.config });
        } else {
          if (password !== confirm) throw new Error('Passwords do not match');
          await api({ type: 'PROTECT_DEFAULT_WALLET', password });
        }
        await onDone();
      } else if (status.passkey) authorization = await unlockWithPasskey(status.passkey);
      setPhrase(await api<string>({ type: 'GET_RECOVERY_PHRASE', password: authorization }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to protect wallet'); }
    finally { setBusy(false); setPassword(''); setConfirm(''); }
  }
  return <section className="security-page"><header className="page-bar"><button className="icon-button" aria-label="Back" disabled={busy} onClick={onClose}><ArrowLeft size={21} /></button><h2>{phrase ? 'Back up your wallet' : status.passwordProtected ? 'Recovery phrase' : 'Protect your wallet'}</h2></header>
    {phrase ? <><div className="security-symbol"><ShieldCheck size={32} /></div><h3>Your recovery phrase</h3><p>Write these words down in order and store them offline. Anyone with this phrase can control your wallet.</p><div className="recovery-grid">{phrase.split(' ').map((word, i) => <span key={i}><small>{i + 1}</small>{word}</span>)}</div><label className="check-label"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />I saved my recovery phrase in a safe place.</label><button className="primary" disabled={!saved || busy} onClick={async () => { setBusy(true); try { await api({ type: 'CONFIRM_BACKUP' }); setPhrase(''); await onDone(); onClose(); } catch { setError('Unable to save backup confirmation'); } finally { setBusy(false); } }}>Done</button></> : <><div className="security-symbol">{status.passkey || method === 'passkey' ? <Fingerprint size={34} /> : <KeyRound size={32} />}</div><p>{status.passwordProtected ? 'Verify your identity before viewing the recovery phrase.' : 'Your first wallet is ready. Add protection, then back up your recovery phrase.'}</p>
      {!status.passwordProtected && <div className="protection-choices"><button className={method === 'passkey' ? 'selected' : ''} onClick={() => setMethod('passkey')}><Fingerprint /><span><strong>Passkey</strong><small>Unlock with your device. No wallet password.</small></span></button><button className={method === 'password' ? 'selected' : ''} onClick={() => setMethod('password')}><KeyRound /><span><strong>Password</strong><small>Protect with a password you remember.</small></span></button></div>}
      <form onSubmit={submit}>{(status.passwordProtected ? !status.passkey : method === 'password') && <><label>{status.passwordProtected ? 'Wallet password' : 'New password'}<input type="password" minLength={10} autoComplete={status.passwordProtected ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} required /></label>{!status.passwordProtected && <label>Confirm password<input type="password" minLength={10} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required /></label>}</>}
      {!status.passwordProtected && method === 'passkey' && <p className="fine-print">Requires a Passkey provider that supports encrypted wallets (PRF). Your browser will ask you to create and verify it. Keep your recovery phrase even if your Passkey syncs.</p>}
      <button className="primary" disabled={busy}>{busy ? 'Verifying…' : status.passwordProtected ? status.passkey ? 'Verify Passkey & view phrase' : 'View recovery phrase' : method === 'passkey' ? 'Set up Passkey' : 'Set password & back up'}</button></form></>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
