import { t } from './i18n';
import { unlockWithPasskey } from '../passkey';
import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api, type WalletStatus } from './api';
import type { WalletImport } from '../import-wallet';

export const emptyImport = (): WalletImport => ({ kind: 'mnemonic', text: '', family: 'evm', password: '' });
export function ImportFields({ value, onChange }: { value: WalletImport; onChange: (value: WalletImport) => void }) {
  const [error, setError] = useState('');
  return <>
    <label>{t("Import format")}<select value={value.kind} onChange={e => onChange({ ...emptyImport(), kind: e.target.value as WalletImport['kind'] })}>
      <option value="mnemonic">{t("Recovery phrase")}</option><option value="privateKey">{t("Plaintext private key")}</option><option value="encrypted">{t("Encrypted backup / keystore JSON")}</option>
    </select></label>
    {value.kind !== 'mnemonic' && <label>{t("Key network")}<select value={value.family} onChange={e => onChange({ ...value, family: e.target.value as WalletImport['family'] })}>
      <option value="evm">{t("EVM")}</option><option value="solana">{t("Solana")}</option><option value="bitcoin">{t("Bitcoin")}</option><option value="tron">{t("TRON")}</option>
    </select></label>}
    {value.kind !== 'mnemonic' && value.family === 'bitcoin' && <label>{t("Bitcoin address type")}<select value={value.bitcoinAddressType ?? 'native-segwit'} onChange={e => onChange({ ...value, bitcoinAddressType: e.target.value as 'native-segwit' | 'taproot' })}><option value="native-segwit">{t("Native SegWit (bc1q)")}</option><option value="taproot">{t("Taproot (bc1p)")}</option></select></label>}
    <label>{value.kind === 'mnemonic' ? t("Recovery phrase") : value.kind === 'privateKey' ? t("Private key") : t("Encrypted JSON")}
      <textarea rows={4} maxLength={700000} autoComplete="off" spellCheck={false} value={value.text} onChange={e => onChange({ ...value, text: e.target.value })} required /></label>
    {value.kind === 'encrypted' && <>
      <label>{t("Backup file")}<input type="file" accept=".json,application/json" onChange={async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 700000) return setError('Backup exceeds the size limit');
        onChange({ ...value, text: await file.text() }); setError('');
      }} /></label>
      <label>{t("Backup password")}<input type="password" autoComplete="off" value={value.password} onChange={e => onChange({ ...value, password: e.target.value })} required /></label>
      <p className="fine-print">{t("FnzSafe extension backups, desktop Argon2 encrypted keys/phrases and standard EVM keystores are supported.")}</p>
    </>}
    {value.kind === 'privateKey' && <p className="fine-print">{t("EVM/TRON: hex. Solana: base58, seed hex or JSON byte array. Bitcoin: compressed mainnet WIF or hex. Imported keys need their own backup.")}</p>}
    {error && <p className="error">{t(error)}</p>}
  </>;
}
export function RecoverySettings({ status, onRefresh, initialMode, onClose, onBusyChange }: { status: WalletStatus; onRefresh: () => Promise<void>; initialMode?: 'import' | 'export'; onClose?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [mode, setMode] = useState<'import' | 'export' | null>(initialMode ?? null);
  const [value, setValue] = useState(emptyImport);
  const [password, setPassword] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const authorization = status.passkey ? await unlockWithPasskey(status.passkey) : password;
      if (mode === 'import') { await api({ type: 'IMPORT_ACCOUNTS', password: authorization, import: value }); await onRefresh(); }
      else {
        const backup = await api({ type: 'EXPORT_BACKUP', password: authorization, backupPassword });
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'fnzsafe-extension-backup.json'; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      setMode(initialMode ?? null); setValue(emptyImport()); onClose?.();
    } catch (e) { setError(e instanceof Error ? e.message : 'Wallet operation failed'); }
    finally { setBusy(false); setPassword(''); setBackupPassword(''); }
  }
  return <section className="settings-panel"><h3>{t("Recovery & backup")}</h3>
    {!mode ? <div className="modal-actions"><button onClick={() => setMode('import')}>{t("Import accounts")}</button><button onClick={() => setMode('export')}>{t("Export encrypted backup")}</button></div> :
      <form onSubmit={submit}>
        {mode === 'import' && <ImportFields value={value} onChange={setValue} />}
        {mode === 'export' && <p>{t("This backup includes every imported account. Keep its wallet password separately.")}</p>}
        {!status.passkey && <label>{t("Current wallet password")}<input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" /></label>}
        {status.passkey && mode === 'export' && <label>{t("Backup file password")}<input type="password" minLength={10} value={backupPassword} onChange={e => setBackupPassword(e.target.value)} required autoComplete="new-password" /><span className="fine-print">{t("Choose a separate password so this file can be restored without your Passkey.")}</span></label>}
        {status.passkey && <p className="fine-print">{t("Your Passkey will be verified before this operation.")}</p>}
        {error && <p className="error">{t(error)}</p>}
        <div className="modal-actions"><button type="button" disabled={busy} onClick={() => { setMode(initialMode ?? null); setValue(emptyImport()); setPassword(''); setBackupPassword(''); onClose?.(); }}>{t("Cancel")}</button><button disabled={busy}>{busy ? <><LoaderCircle size={15} className="spin" /> {t("Working...")}</> : mode === 'import' ? t("Import accounts") : t("Download backup")}</button></div>
      </form>}
  </section>;
}
export function RpcSettings({ status, onRefresh, onBusyChange }: { status: WalletStatus; onRefresh: () => Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const [key, setKey] = useState(`evm:${status.settings.evmChainId}`);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const chain = status.chains.find(c => c.key === key)!;
  return <section className="settings-panel"><h3>{t("Network RPC")}</h3>
    <label>{t("RPC network")}<select disabled={busy} value={key} onChange={e => setKey(e.target.value)}>{status.chains.filter(c => c.rpcUrl).map(c => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
    <RpcEditor key={key} chainKey={key} initial={chain.rpcUrl!} onRefresh={onRefresh} onBusyChange={setBusy} />
  </section>;
}
function RpcEditor({ chainKey, initial, onRefresh, onBusyChange }: { chainKey: string; initial: string; onRefresh: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const [url, setUrl] = useState(initial), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => setUrl(initial), [initial]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  async function save(reset = false) {
    setBusy(true); setMessage('');
    try { await api({ type: 'SET_RPC', key: chainKey, url, reset }); await onRefresh(); setMessage('RPC saved'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'RPC verification failed'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={e => { e.preventDefault(); void save(); }}>
    <label>{t("RPC URL")}<input type={visible ? "text" : "password"} value={url} maxLength={2048} autoComplete="off" spellCheck={false} onChange={e => setUrl(e.target.value)} required /></label>
    <button type="button" onClick={() => setVisible(!visible)}>{visible ? t("Hide URL") : t("Show URL")}</button>
    <p className="fine-print">{t("The endpoint must match this network. Custom endpoints do not fall back to public providers. Token discovery uses a separate index service.")}</p>
    {message && <p role="status">{t(message)}</p>}
    <div className="modal-actions"><button type="button" disabled={busy} onClick={() => void save(true)}>{t("Restore default")}</button><button disabled={busy}>{busy ? <><LoaderCircle size={15} className="spin" /> {t("Verifying...")}</> : t("Verify & save")}</button></div>
  </form>;
}
