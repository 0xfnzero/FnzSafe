import { useEffect, useState } from 'react';
import { Check, Copy, Plus, Download } from 'lucide-react';
import type { PublicAccount, WalletStatus } from './api';
import type { ChainInfo } from '../types';
import { t } from './i18n';

export function WalletSwitcher({ status, search, busy, onSelect, onCreate, onImport }: {
  status: WalletStatus; search: string; busy: boolean;
  onSelect: (account: PublicAccount, chain: ChainInfo, close: boolean) => void;
  onCreate: (name: string) => void; onImport: () => void;
}) {
  const [copied, setCopied] = useState(''), [error, setError] = useState('');
  const [name, setName] = useState(status.suggestedWalletName);
  useEffect(() => setName(status.suggestedWalletName), [status.suggestedWalletName]);
  const active = status.accounts.find(a => a.id === status.settings.activeAccountId) ?? status.accounts[0];
  const wallet = status.wallets.find(w => w.id === active.walletId)!;
  const accounts = status.accounts.filter(a => a.walletId === wallet.id);
  const query = search.trim().toLowerCase();
  const matches = status.wallets.filter(w => `${w.name} ${status.accounts.filter(a => a.walletId === w.id).map(a => a.address).join(' ')}`.toLowerCase().includes(query));
  function currentChain(account: PublicAccount) {
    return status.chains.find(c => c.family === account.family && (c.family === 'evm' ? c.chainId === status.settings.evmChainId : c.family === 'solana' ? c.key === `solana:${status.settings.solanaCluster}` : true))!;
  }
  const priority = ['evm:1', 'solana:mainnet-beta', 'bitcoin:mainnet', 'tron:mainnet'];
  const ordered = [...status.chains].sort((a, b) => (priority.includes(a.key) ? priority.indexOf(a.key) : a.testnet || a.key.endsWith('devnet') ? 100 : 10) - (priority.includes(b.key) ? priority.indexOf(b.key) : b.testnet || b.key.endsWith('devnet') ? 100 : 10));
  const rows = ordered.filter(c => accounts.some(a => a.family === c.family)).flatMap(c => accounts.filter(a => a.family === c.family).map(a => ({ chain: c, account: a })));
  return <div className="wallet-browser"><div className="wallet-browser-columns"><div className="wallet-tabs" role="tablist" aria-label={t('Wallets')} aria-orientation="vertical">
    {matches.map((w, index) => <button key={w.id} id={`wallet-tab-${w.id}`} role="tab" aria-selected={w.id === wallet.id} aria-controls="wallet-chain-list" tabIndex={w.id === wallet.id || !matches.some(item => item.id === wallet.id) && index === 0 ? 0 : -1} onKeyDown={e => {
      const nextIndex = e.key === 'ArrowDown' ? (index + 1) % matches.length : e.key === 'ArrowUp' ? (index + matches.length - 1) % matches.length : e.key === 'Home' ? 0 : e.key === 'End' ? matches.length - 1 : -1;
      if (nextIndex < 0) return; e.preventDefault(); const next = document.getElementById(`wallet-tab-${matches[nextIndex].id}`); next?.focus(); next?.click();
    }} disabled={busy} onClick={() => {
      const group = status.accounts.filter(a => a.walletId === w.id), next = group.find(a => a.family === active.family) ?? group[0];
      onSelect(next, currentChain(next), false); setCopied(''); setError('');
    }}><strong title={w.name}>{w.name}</strong></button>)}
    {!matches.length && <p className="fine-print">{t('No matching wallets')}</p>}
  </div><section id="wallet-chain-list" className="wallet-chain-panel" role="tabpanel" aria-labelledby={`wallet-tab-${wallet.id}`}><header><h3>{wallet.name}</h3><p>{t(wallet.hasRecoveryPhrase ? 'One phrase · all chains' : 'Imported chain account')}</p></header><div className="wallet-chain-list">
    {rows.map(({ chain, account }) => {
      const selected = account.id === active.id && currentChain(active).key === chain.key;
      const key = `${chain.key}:${account.id}`;
      const label = chain.family === 'bitcoin' ? account.address.startsWith('bc1p') ? 'Bitcoin · Taproot' : 'Bitcoin · SegWit' : chain.name;
      return <div className={`wallet-chain-row ${selected ? 'selected' : ''}`} key={key}><button className="wallet-chain-select" disabled={busy} aria-pressed={selected} aria-label={t('Switch to {network}', { network: label })} onClick={() => onSelect(account, chain, true)}><img src={`chain-icons/${chain.icon}`} alt="" /><span><strong title={label}>{label}</strong><small title={account.address}>{account.address.slice(0, 7)}…{account.address.slice(-5)}</small></span>{selected && <Check size={14} />}</button><button className="wallet-chain-copy" aria-label={t('Copy {network} address', { network: label })} onClick={async () => { try { await navigator.clipboard.writeText(account.address); setCopied(key); setError(''); } catch { setError('Copy failed'); } }}>{copied === key ? <Check size={16} /> : <Copy size={16} />}</button></div>;
    })}
  </div></section></div>
    <label className="wallet-create-name">{t('New wallet name')}<input value={name} placeholder={status.suggestedWalletName} maxLength={80} disabled={busy} onChange={e => setName(e.target.value)} /></label>
    <footer className="wallet-browser-actions"><button className="primary" disabled={busy} onClick={() => onCreate(name.trim() || status.suggestedWalletName)}><Plus size={18} />{t(busy ? 'Creating wallet…' : 'Create wallet')}</button><button disabled={busy} onClick={onImport}><Download size={17} />{t('Import wallet')}</button></footer>
    <p className="fine-print">{t('One recovery phrase for all supported chains. Back up later in Settings.')}</p>
    {copied && <p role="status" className="success-note">{t('Address copied')}</p>}{error && <p role="alert" className="error">{t(error)}</p>}
  </div>;
}
