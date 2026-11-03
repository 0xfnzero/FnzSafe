import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, Download, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { api, compact, type WalletStatus } from './api';
import { unlockWithPasskey } from './passkey-client';
import { splitBackupSecret } from '../secret-backup';

type ExportResult = { value: string; address?: string; derivationPath?: string };
export function BackupManager({ status, onClose, onDone }: { status: WalletStatus; onClose: () => void; onDone: () => Promise<void> }) {
  const wallet = status.wallets.find(w => w.id === status.activeWalletId) ?? status.wallets[0];
  const accounts = status.accounts.filter(a => a.walletId === wallet.id);
  const [kind, setKind] = useState<'mnemonic' | 'privateKey'>(wallet.hasRecoveryPhrase ? 'mnemonic' : 'privateKey');
  const [accountId, setAccountId] = useState(accounts.find(a => a.id === status.settings.activeAccountId)?.id ?? accounts[0].id);
  const [mode, setMode] = useState<'encrypted' | 'plaintext' | 'qr' | 'segments'>('encrypted');
  const [password, setPassword] = useState(''), [backupPassword, setBackupPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null), [qr, setQr] = useState(''), [segments, setSegments] = useState(3);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0);
  function clear() { generation.current++; setResult(null); setQr(''); setPassword(''); setBackupPassword(''); setConfirm(''); setNotice(''); }
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { clear(); }, [kind, mode, accountId, wallet.id]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(clear, 90000);
    const check = setInterval(() => { void api<{ locked: boolean }>({ type: 'SESSION_STATUS' }).then(s => { if (s.locked) clear(); }).catch(clear); }, 1000);
    return () => { clearTimeout(timer); clearInterval(check); };
  }, [result]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    const current = ++generation.current;
    try {
      if (mode === 'encrypted' && backupPassword !== confirm) throw new Error('Passwords do not match');
      const authorization = status.passkey ? await unlockWithPasskey(status.passkey) : password;
      const exported = await api<ExportResult>({ type: 'EXPORT_SECRET', walletId: wallet.id, accountId, kind, format: mode === 'encrypted' ? 'encrypted' : 'plaintext', password: authorization, backupPassword });
      const code = mode === 'qr' ? await QRCode.toDataURL(exported.value, { width: 260, margin: 2, errorCorrectionLevel: 'M' }) : '';
      if (current !== generation.current) return;
      setResult(exported); setQr(code);
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Export failed'); }
    finally { setBusy(false); setPassword(''); setBackupPassword(''); setConfirm(''); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Copied'); }
    catch { setError('Copy failed'); }
  }
  function download(value: string, suffix = '') {
    const encrypted = mode === 'encrypted';
    const url = URL.createObjectURL(new Blob([value], { type: encrypted ? 'application/json' : 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = `fnzsafe-${kind}${suffix}.${encrypted ? 'json' : 'txt'}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Download started');
  }
  return <section className="security-page backup-page"><header className="page-bar"><button className="icon-button" aria-label={t("Back")} disabled={busy} onClick={() => { clear(); onClose(); }}><ArrowLeft size={21} /></button><h2>{t("Backup & export")}</h2></header>
    <div className="backup-wallet"><ShieldCheck size={24} /><span><strong>{wallet.name}</strong><small>{t("Choose what to back up")}</small></span></div>
    <form onSubmit={submit}><fieldset disabled={busy || !!result}>
      <label>{t("Backup content")}<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>{wallet.hasRecoveryPhrase && <option value="mnemonic">{t("Recovery phrase · all derived chains")}</option>}<option value="privateKey">{t("Private key · one chain account")}</option></select></label>
      {kind === 'mnemonic' && accounts.some(a => a.derivationPath && !["m/44'/60'/0'/0/0", "m/44'/501'/0'/0'", "m/44'/195'/0'/0/0", "m/86'/0'/0'/0/0", "m/84'/0'/0'/0/0"].includes(a.derivationPath)) && <p className="warning">{t('This wallet uses custom derivation paths. Also save a full encrypted backup to preserve its exact accounts.')}</p>}
      {kind === 'privateKey' && <label>{t("Chain account")}<select value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(a => <option value={a.id} key={a.id}>{a.name} · {compact(a.address)}</option>)}</select></label>}
      <label>{t("Export format")}<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="encrypted">{t("Encrypted file or string")}</option><option value="plaintext">{t("Plaintext")}</option><option value="qr">{t("Plaintext QR code")}</option><option value="segments">{t("Ordered plaintext segments")}</option></select></label>
      {mode === 'segments' && <label>{t("Number of segments")}<input type="number" min={1} max={12} value={segments} onChange={e => setSegments(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} /></label>}
    </fieldset>
    {!result && <>
      {mode === 'encrypted' ? <><label>{t("Backup password")}<input type="password" minLength={10} maxLength={1024} autoComplete="new-password" required value={backupPassword} onChange={e => setBackupPassword(e.target.value)} /></label><label>{t("Confirm backup password")}<input type="password" minLength={10} autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} /></label><p className="fine-print">{t("This password restores the backup independently of your Passkey or wallet password.")}</p></> : <p className="warning">{t("Anyone with this secret can control the account. Keep it offline. Plaintext segments must all be joined in order; they are not threshold shares.")}</p>}
      {!status.passkey && <label>{t("Current wallet password")}<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>}
      <button className="primary" disabled={busy}>{busy ? t("Preparing backup…") : status.passkey ? t("Verify Passkey & export") : t("Verify & export")}</button>
    </>}
    </form>
    {result && <div className="backup-result">
      <p className="fine-print">{t("Hidden automatically after 90 seconds. Clear the clipboard after saving.")}</p>
      {result.address && <dl><dt>{t("Address")}</dt><dd>{result.address}</dd><dt>{t("Derivation path")}</dt><dd>{result.derivationPath ?? t('Imported key')}</dd></dl>}
      {mode === 'qr' && <img className="receive-qr" src={qr} alt={t("Secret QR code")} />}
      {mode === 'segments' ? <div className="backup-segments">{splitBackupSecret(result.value, segments).map((part, i) => <div key={i}><strong>{i + 1} / {segments}</strong><code>{part}</code><div className="modal-actions"><button onClick={() => void copy(part)}><Copy size={16} />{t("Copy")}</button><button onClick={() => download(part, `-part-${i + 1}-of-${segments}`)}><Download size={16} />{t("Download")}</button></div></div>)}</div> : <><textarea aria-label={t("Backup string")} readOnly rows={mode === 'encrypted' ? 5 : 3} value={result.value} spellCheck={false} /><div className="modal-actions"><button onClick={() => void copy(result.value)}><Copy size={16} />{t("Copy string")}</button><button onClick={() => download(result.value)}><Download size={16} />{t("Download file")}</button></div></>}
      {kind === 'privateKey' && accounts.find(a => a.id === accountId)?.family === 'bitcoin' && <p className="fine-print">{t("Bitcoin encrypted backups preserve the address type in FnzSafe extension format. For plaintext recovery, choose the same Native SegWit or Taproot address type.")}</p>}
      <button className="secondary-wide" onClick={clear}>{t("Hide backup")}</button>
      {kind === 'mnemonic' && <button className="primary" onClick={async () => { try { await api({ type: 'CONFIRM_BACKUP', walletId: wallet.id }); clear(); await onDone(); onClose(); } catch { setError('Unable to save backup confirmation'); } }}>{t("I saved this backup")}</button>}
    </div>}
    {notice && <p role="status" className="success-note">{t(notice)}</p>}{error && <p role="alert" className="error">{t(error)}</p>}
  </section>;
}
