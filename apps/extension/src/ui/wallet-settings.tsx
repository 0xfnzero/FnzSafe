import { useEffect, useState } from 'react';
import { api, type WalletStatus } from './api';
import type { WalletImport } from '../import-wallet';

export const emptyImport = (): WalletImport => ({ kind: 'mnemonic', text: '', family: 'evm', password: '' });
export function ImportFields({ value, onChange }: { value: WalletImport; onChange: (value: WalletImport) => void }) {
  const [error, setError] = useState('');
  return <>
    <label>Import format<select value={value.kind} onChange={e => onChange({ ...emptyImport(), kind: e.target.value as WalletImport['kind'] })}>
      <option value="mnemonic">Recovery phrase</option><option value="privateKey">Plaintext private key</option><option value="encrypted">Encrypted backup / keystore JSON</option>
    </select></label>
    {value.kind !== 'mnemonic' && <label>Key network<select value={value.family} onChange={e => onChange({ ...value, family: e.target.value as WalletImport['family'] })}>
      <option value="evm">EVM</option><option value="solana">Solana</option><option value="bitcoin">Bitcoin (Native SegWit)</option><option value="tron">TRON</option>
    </select></label>}
    <label>{value.kind === 'mnemonic' ? 'Recovery phrase' : value.kind === 'privateKey' ? 'Private key' : 'Encrypted JSON'}
      <textarea rows={4} maxLength={700000} autoComplete="off" spellCheck={false} value={value.text} onChange={e => onChange({ ...value, text: e.target.value })} required /></label>
    {value.kind === 'encrypted' && <>
      <label>Backup file<input type="file" accept=".json,application/json" onChange={async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 700000) return setError('Backup exceeds the size limit');
        onChange({ ...value, text: await file.text() }); setError('');
      }} /></label>
      <label>Backup password<input type="password" autoComplete="off" value={value.password} onChange={e => onChange({ ...value, password: e.target.value })} required /></label>
      <p className="fine-print">FnzSafe extension backups, desktop Argon2 encrypted keys/phrases and standard EVM keystores are supported.</p>
    </>}
    {value.kind === 'privateKey' && <p className="fine-print">EVM/TRON: hex. Solana: base58, seed hex or JSON byte array. Bitcoin: compressed mainnet WIF or hex. Imported keys need their own backup.</p>}
    {error && <p className="error">{error}</p>}
  </>;
}
export function RecoverySettings({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [mode, setMode] = useState<'import' | 'export' | null>(null);
  const [value, setValue] = useState(emptyImport);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'import') { await api({ type: 'IMPORT_ACCOUNTS', password, import: value }); await onRefresh(); }
      else {
        const backup = await api({ type: 'EXPORT_BACKUP', password });
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'fnzsafe-extension-backup.json'; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      setMode(null); setValue(emptyImport());
    } catch (e) { setError(e instanceof Error ? e.message : 'Wallet operation failed'); }
    finally { setBusy(false); setPassword(''); }
  }
  return <section className="settings-panel"><h3>Recovery & backup</h3>
    {!mode ? <div className="modal-actions"><button onClick={() => setMode('import')}>Import accounts</button><button onClick={() => setMode('export')}>Export encrypted backup</button></div> :
      <form onSubmit={submit}>
        {mode === 'import' && <ImportFields value={value} onChange={setValue} />}
        {mode === 'export' && <p>This backup includes every imported account. Keep its wallet password separately.</p>}
        <label>Current wallet password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" /></label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions"><button type="button" disabled={busy} onClick={() => { setMode(null); setValue(emptyImport()); setPassword(''); }}>Cancel</button><button disabled={busy}>{busy ? 'Working...' : mode === 'import' ? 'Import accounts' : 'Download backup'}</button></div>
      </form>}
  </section>;
}
export function RpcSettings({ status, onRefresh }: { status: WalletStatus; onRefresh: () => Promise<void> }) {
  const [key, setKey] = useState(`evm:${status.settings.evmChainId}`);
  const chain = status.chains.find(c => c.key === key)!;
  return <section className="settings-panel"><h3>Network RPC</h3>
    <label>RPC network<select value={key} onChange={e => setKey(e.target.value)}>{status.chains.filter(c => c.rpcUrl).map(c => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
    <RpcEditor key={key} chainKey={key} initial={chain.rpcUrl!} onRefresh={onRefresh} />
  </section>;
}
function RpcEditor({ chainKey, initial, onRefresh }: { chainKey: string; initial: string; onRefresh: () => Promise<void> }) {
  const [url, setUrl] = useState(initial), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => setUrl(initial), [initial]);
  async function save(reset = false) {
    setBusy(true); setMessage('');
    try { await api({ type: 'SET_RPC', key: chainKey, url, reset }); await onRefresh(); setMessage('RPC saved'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'RPC verification failed'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={e => { e.preventDefault(); void save(); }}>
    <label>RPC URL<input type={visible ? 'text' : 'password'} value={url} maxLength={2048} autoComplete="off" spellCheck={false} onChange={e => setUrl(e.target.value)} required /></label>
    <button type="button" onClick={() => setVisible(!visible)}>{visible ? 'Hide URL' : 'Show URL'}</button>
    <p className="fine-print">The endpoint must match this network. Custom endpoints do not fall back to public providers. Token discovery uses a separate index service.</p>
    {message && <p role="status">{message}</p>}
    <div className="modal-actions"><button type="button" disabled={busy} onClick={() => void save(true)}>Restore default</button><button disabled={busy}>{busy ? 'Verifying...' : 'Verify & save'}</button></div>
  </form>;
}
