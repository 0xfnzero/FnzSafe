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

  return <div className="modal-backdrop"><form ref={ref} className="modal" role="dialog" aria-modal="true" aria-label="Send native asset" onSubmit={submit}>
    <h2>{confirming ? 'Confirm transfer' : `Send ${chain.symbol}`}</h2>
    {confirming ? <dl><dt>Network</dt><dd>{chain.name}</dd><dt>Recipient</dt><dd>{recipient}</dd><dt>Amount</dt><dd>{amount} {chain.symbol}</dd></dl> : <><label>Recipient<input value={recipient} onChange={(event) => setRecipient(event.target.value.trim())} required /></label><label>Amount<input type="number" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label></>}
    {error && <p className="error">{error}</p>}
    <div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Submitting...' : confirming ? 'Confirm' : 'Review'}</button></div>
  </form></div>;
}

export function SettingsView({ status, onLock, onRefresh }: { status: WalletStatus; onLock: () => void; onRefresh: () => Promise<void> }) {
  return <section className="settings-view"><div className="page-heading"><span className="eyebrow">YOUR WALLET, YOUR WAY</span><h2>Settings</h2><p>A little more personal. Just as secure.</p></div><ThemeSettings /><h3 className="group-label">Security & privacy</h3><div className="settings-list">
    <button onClick={onLock}><Lock /><span><strong>{status.passwordProtected ? 'Lock wallet' : 'Protect wallet'}</strong><small>{status.passwordProtected ? 'Clear decrypted keys from memory' : 'Set up a Passkey or password'}</small></span></button>
    <div><ShieldCheck /><span><strong>{status.passkey ? 'Passkey protection' : status.passwordProtected ? 'Auto-lock' : 'Browser storage'}</strong><small>{status.passwordProtected ? 'Five minutes of inactivity' : 'Not protected by a Passkey or password yet'}</small></span><span className="status-dot" /></div>

    <button onClick={async () => {
      await api({ type: 'SET_ENHANCED_ASSET_DETECTION', enabled: !status.settings.enhancedAssetDetection });
      await onRefresh();
    }}><WalletCards /><span><strong>Enhanced token detection</strong><small>{status.settings.enhancedAssetDetection ? 'On by default - public addresses may be sent to configured index services' : 'Off - native assets and manually imported tokens only'}</small></span>{status.settings.enhancedAssetDetection ? <Check /> : null}</button>
    <div><Globe2 /><span><strong>Connected sites</strong><small>{status.connectedSites.length === 0 ? 'No sites currently authorized' : `${status.connectedSites.length} authorized`}</small></span></div>
    {status.connectedSites.map((site) => <button key={site.origin} onClick={async () => {
      await api({ type: 'REVOKE_PERMISSION', origin: site.origin });
      await onRefresh();
    }}><span><strong>{new URL(site.origin).hostname}</strong><small>{site.families.join(' + ').toUpperCase()} - {site.accountCount} account - {site.networkCount} network</small></span><X aria-label={`Disconnect ${new URL(site.origin).hostname}`} /></button>)}
    {status.connectedSites.length > 1 && <button className="danger-action" onClick={async () => { await api({ type: 'CLEAR_PERMISSIONS' }); await onRefresh(); }}><X /><span><strong>Disconnect all sites</strong><small>Revoke every DApp connection</small></span></button>}
  </div><RpcSettings status={status} onRefresh={onRefresh} />{status.passwordProtected && <RecoverySettings status={status} onRefresh={onRefresh} />}</section>;
}
