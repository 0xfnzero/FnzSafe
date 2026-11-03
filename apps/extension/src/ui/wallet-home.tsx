import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Globe2, History, Home, Lock, Menu, Plus, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import QRCode from 'qrcode';
import { api, compact, type WalletStatus } from './api';
import type { ChainInfo, PortfolioAsset, PortfolioSnapshot } from '../types';
import { ThemeControl } from './theme';
import { SafeView } from './safe-view';
import { ActivityView, EvmSendDialog, ImportToken } from './transactions';
import { SettingsView, SendDialog } from './wallet-panels';
import { RecoverySettings } from './wallet-settings';
import { useDialogFocus } from './dialog-focus';
import { WalletSecurity } from './wallet-security';

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const amount = (value: string) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 }).format(Number(value)) : value;
type Tab = 'wallet' | 'activity' | 'safe' | 'settings';
type Drawer = 'accounts' | 'networks' | 'receive' | 'import' | 'token' | 'asset' | null;

export function WalletHome({ status, refresh }: { status: WalletStatus; refresh: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('wallet'), [drawer, setDrawer] = useState<Drawer>(null);
  const [security, setSecurity] = useState(false), [send, setSend] = useState(false);
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [hidden, setHidden] = useState(false), [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null), [loading, setLoading] = useState(true), [portfolioError, setPortfolioError] = useState('');
  const [asset, setAsset] = useState<PortfolioAsset | null>(null);
  const account = status.accounts.find(a => a.id === status.settings.activeAccountId) ?? status.accounts[0];
  const family = account?.family ?? 'evm';
  const chain = status.chains.find(c => c.family === family && (family === 'evm' ? c.chainId === status.settings.evmChainId : family === 'solana' ? c.key === `solana:${status.settings.solanaCluster}` : true))!;
  const request = useRef(0);
  const refreshPortfolio = useCallback(async (force = false) => {
    const id = ++request.current; setLoading(true); setPortfolioError('');
    try { const value = await api<PortfolioSnapshot>({ type: 'GET_PORTFOLIO', family, force }); if (id === request.current) setPortfolio(value); }
    catch (e) { if (id === request.current) setPortfolioError(e instanceof Error ? e.message : 'Unable to load assets'); }
    finally { if (id === request.current) setLoading(false); }
  }, [family, account?.id, chain?.key, chain?.rpcUrl, status.settings.enhancedAssetDetection]);
  useEffect(() => { setPortfolio(null); setAsset(null); void refreshPortfolio(); return () => { request.current++; }; }, [refreshPortfolio]);
  useEffect(() => { setSearch(''); setError(''); }, [drawer]);
  const total = portfolio?.assets.reduce((sum, a) => sum + (a.valueUsd ?? 0), 0) ?? 0;
  const native = portfolio?.assets.find(a => a.native);
  const priced = portfolio?.assets.some(a => a.valueUsd !== undefined);
  const zero = portfolio?.assets.length && portfolio.assets.every(a => a.rawBalance === '0');
  const totalLabel = hidden ? '••••••' : priced || zero ? money(total) : '—';
  const filtered = portfolio?.assets.filter(a => `${a.name} ${a.symbol} ${a.address ?? ''}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const openDrawer = (value: Drawer) => { setDrawer(value); setSearch(''); setError(''); };
  async function copy() {
    try { await navigator.clipboard.writeText(account.address); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setError('Copy failed. Select and copy the address manually.'); }
  }
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete operation'); } finally { setBusy(false); } }
  async function chooseNetwork(next: ChainInfo) {
    await run(async () => {
      const nextAccount = status.accounts.find(a => a.id === account.id && a.family === next.family) ?? status.accounts.find(a => a.family === next.family);
      if (!nextAccount) throw new Error('Import an account for this network first');
      await api({ type: 'SET_NETWORK', key: next.key });
      if (nextAccount.id !== account.id) await api({ type: 'SET_ACTIVE_ACCOUNT', accountId: nextAccount.id });
      await refresh(); setDrawer(null); setTab('wallet');
    });
  }
  function startSend(selected?: PortfolioAsset) {
    if (!status.passwordProtected) { setDrawer(null); setSecurity(true); return; }
    setAsset(selected ?? null); setDrawer(null); setSend(true);
  }
  function protectOrImport() { setDrawer(null); if (status.passwordProtected) openDrawer('import'); else setSecurity(true); }
  if (security) return <main className="shell wallet-shell"><WalletSecurity status={status} onDone={refresh} onClose={() => setSecurity(false)} /></main>;
  return <main className="shell wallet-shell">
    <header className="wallet-header">
      <div className="wallet-title-row"><button className="account-trigger" onClick={() => openDrawer('accounts')} aria-label="Switch account"><span className="identicon">{account?.name?.slice(0, 1) ?? '1'}</span><span>{account?.name?.replace('EVM Account', 'Account') ?? 'Wallet 1'}</span><ChevronDown size={18} /></button><button className="icon-button" aria-label="Wallet settings" onClick={() => setTab(tab === 'settings' ? 'wallet' : 'settings')}><Menu size={23} /></button></div>
      <div className="wallet-address-row"><button className="address-pill" aria-label="Copy wallet address" onClick={() => void copy()}><img alt="" src={`chain-icons/${chain.icon}`} /><span>{copied ? 'Copied' : compact(account.address)}</span>{copied ? <Check size={13} /> : <Copy size={13} />}</button><ThemeControl /></div>
    </header>
    {tab === 'wallet' && <section className="portfolio-home">
      <div className="portfolio-card"><div className="portfolio-total"><div className="portfolio-label">Total balance<button className="icon-button" aria-label={hidden ? 'Show balances' : 'Hide balances'} onClick={() => setHidden(!hidden)}>{hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><h1>{totalLabel}</h1><div className="portfolio-subline">{hidden ? 'Balances hidden' : loading && !portfolio ? 'Updating balances…' : native ? `${amount(native.balance)} ${native.symbol}` : portfolioError ? 'Balance unavailable · try refreshing' : 'Select a network to view your assets'}{loading && <RefreshCw size={12} className="spin" />}</div></div>
      <div className="wallet-actions"><Action icon={<ArrowUpRight />} label="Send" disabled={!chain.transactionSupport} onClick={() => startSend()} /><Action icon={<ArrowDownLeft />} label="Receive" onClick={() => openDrawer('receive')} /><Action icon={<ShieldCheck />} label="Multisig" onClick={() => setTab('safe')} /><Action icon={<Globe2 />} label="DApps" disabled={!['evm', 'solana'].includes(family)} onClick={() => void chrome.tabs.create({ url: family === 'solana' ? 'https://jup.ag' : 'https://app.uniswap.org' })} /></div></div>
      {!status.backupConfirmed && <button className="backup-banner" onClick={() => setSecurity(true)}><span className="backup-symbol"><ShieldCheck size={21} /></span><span><strong>{status.passwordProtected ? 'Back up your wallet' : 'Your wallet is ready'}</strong><small>{status.passwordProtected ? 'Keep your recovery phrase safe' : 'Protect with a Passkey or password'}</small></span><ChevronRight size={18} /></button>}
      {!status.passwordProtected && <p className="device-note">Saved in this browser. Protect and back up before adding funds.</p>}
      <section className="assets-panel" aria-label="Wallet assets"><div className="token-tabs"><strong>Tokens</strong><button onClick={() => setTab('activity')}>Activity</button><div /><button className="icon-button" aria-label="Search tokens" onClick={() => { setShowSearch(!showSearch); setFilter(''); }}><Search size={19} /></button><button className="icon-button" aria-label="Add token" disabled={family !== 'evm'} onClick={() => openDrawer('token')}><Plus size={21} /></button></div>
      <div className="token-toolbar"><button className="network-filter" onClick={() => openDrawer('networks')}><SlidersHorizontal size={15} /><span>{chain.name}</span><ChevronDown size={14} /></button><button className="icon-button" aria-label="Refresh assets" disabled={loading} onClick={() => void refreshPortfolio(true)}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div>
      {showSearch && <label className="search-field token-search"><Search size={16} /><input aria-label="Search tokens" placeholder="Search tokens" value={filter} onChange={e => setFilter(e.target.value)} /></label>}
      {portfolioError && <div className="inline-feedback"><span>Assets could not be refreshed.</span><button onClick={() => void refreshPortfolio(true)}>Retry</button><details><summary>Details</summary><p>{portfolioError}</p></details></div>}
      {loading && !portfolio && <div className="token-skeleton" aria-label="Loading assets"><i /><i /><i /></div>}
      <div className="token-list">{filtered.map(a => <button className="token-row" key={a.id} onClick={() => { setAsset(a); openDrawer('asset'); }}><span className="token-logo">{a.native ? <img alt="" src={`chain-icons/${chain.icon}`} /> : a.symbol.slice(0, 2)}<img className="chain-badge" alt={chain.name} src={`chain-icons/${chain.icon}`} /></span><span className="token-name"><strong>{a.symbol}</strong><small>{a.risk === 'spam' ? 'Potential spam' : a.name}</small></span><span className="token-value"><strong>{hidden ? '••••' : a.valueUsd !== undefined ? money(a.valueUsd) : a.rawBalance === '0' ? '$0.00' : '—'}</strong><small>{hidden ? '••••' : `${amount(a.balance)} ${a.symbol}`}</small></span><ChevronRight className="token-chevron" size={15} /></button>)}</div>
      {!loading && !filtered.length && !portfolioError && <div className="empty"><Search size={27} /><strong>{filter ? 'No matching tokens' : 'No assets to show'}</strong><span>{filter ? 'Try a token name or contract address.' : 'Receive assets or add a token contract.'}</span></div>}
      </section>
      {portfolio?.warnings.map(w => <p className="asset-warning" key={w}>{w}</p>)}
      {!chain.transactionSupport && <p className="privacy-hint">Recovery and addresses are supported on this network. Sending is not available yet.</p>}
      {priced && portfolio?.assets.some(a => a.valueUsd === undefined && a.rawBalance !== '0') && <p className="privacy-hint">Total excludes assets without available prices.</p>}
    </section>}
    {tab === 'activity' && <ActivityView family={family} context={`${chain.key}:${account.id}`} />}
    {tab === 'safe' && (family === 'evm' ? <SafeView key={`${chain.key}:${account.id}:${chain.rpcUrl}`} chainId={status.settings.evmChainId} accountId={account.id} /> : <div className="empty-page"><ShieldCheck size={32} /><h2>Safe multisig</h2><p>Choose an EVM network to manage shared wallets.</p><button onClick={() => openDrawer('networks')}>Choose network</button></div>)}
    {tab === 'settings' && <><div className="settings-shortcuts"><button onClick={() => setSecurity(true)}><ShieldCheck size={18} />{status.passwordProtected ? 'Recovery phrase' : 'Protect wallet'}<ChevronRight size={17} /></button><button onClick={protectOrImport}><Plus size={18} />Import accounts<ChevronRight size={17} /></button></div><SettingsView status={status} onLock={() => { if (!status.passwordProtected) setSecurity(true); else void run(async () => { await api({ type: 'LOCK' }); await refresh(); }); }} onRefresh={refresh} /></>}
    {error && !drawer && <p className="error panel-error">{error}</p>}
    <nav aria-label="Wallet navigation">{([{ id: 'wallet', label: 'Home', icon: <Home /> }, { id: 'safe', label: 'Multisig', icon: <ShieldCheck /> }, { id: 'activity', label: 'Activity', icon: <History /> }, { id: 'settings', label: 'Settings', icon: <Settings /> }] as const).map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.icon}{item.label}</button>)}</nav>
    {drawer && <Sheet title={drawer === 'accounts' ? 'Accounts' : drawer === 'networks' ? 'Select network' : drawer === 'receive' ? `Receive ${chain.symbol}` : drawer === 'import' ? 'Import & backup' : drawer === 'token' ? 'Add token' : asset?.symbol ?? 'Token details'} onClose={() => { if (!busy) setDrawer(null); }}>
      {(drawer === 'accounts' || drawer === 'networks') && <label className="search-field"><Search size={18} /><input autoFocus placeholder={drawer === 'accounts' ? 'Search accounts' : 'Search networks'} value={search} onChange={e => setSearch(e.target.value)} /></label>}
      {drawer === 'accounts' && <><div className="selection-list">{status.accounts.filter(a => `${a.name} ${a.address} ${a.family}`.toLowerCase().includes(search.toLowerCase())).map(a => <button key={a.id} disabled={busy} aria-pressed={a.id === account.id} onClick={() => void run(async () => { await api({ type: 'SET_ACTIVE_ACCOUNT', accountId: a.id }); await refresh(); setDrawer(null); setTab('wallet'); })}><span className="identicon">{a.name.slice(0, 1)}</span><span><strong>{a.name}</strong><small>{a.family.toUpperCase()} · {compact(a.address)}</small></span>{a.id === account.id && <Check size={19} />}</button>)}</div><button className="secondary-wide" onClick={protectOrImport}><Plus size={17} />Import an account</button></>}
      {drawer === 'networks' && <div className="selection-list">{status.chains.filter(c => `${c.name} ${c.symbol} ${c.chainId ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(c => <button key={c.key} disabled={busy} aria-pressed={c.key === chain.key} onClick={() => void chooseNetwork(c)}><img alt="" src={`chain-icons/${c.icon}`} /><span><strong>{c.name}</strong><small>{c.testnet ? 'Test network' : c.family.toUpperCase()}{!c.transactionSupport ? ' · Address only' : ''}</small></span>{c.key === chain.key && <Check size={19} />}</button>)}</div>}
      {drawer === 'receive' && <ReceiveAddress address={account.address} chain={chain} copied={copied} onCopy={() => void copy()} protectedWallet={status.passwordProtected} onProtect={() => { setDrawer(null); setSecurity(true); }} />}
      {drawer === 'import' && <RecoverySettings status={status} onRefresh={refresh} />}
      {drawer === 'token' && <ImportToken onImported={() => { setDrawer(null); void refreshPortfolio(true); }} />}
      {drawer === 'asset' && asset && <div className="token-detail"><span className="large-token-logo">{asset.native ? <img alt="" src={`chain-icons/${chain.icon}`} /> : asset.symbol.slice(0, 2)}</span><h2>{hidden ? '••••' : `${amount(asset.balance)} ${asset.symbol}`}</h2><p>{hidden ? '••••' : asset.valueUsd !== undefined ? money(asset.valueUsd) : 'Price unavailable'}</p><div className="modal-actions"><button className="primary" disabled={!chain.transactionSupport || (!asset.native && family !== 'evm')} onClick={() => startSend(asset)}><ArrowUpRight size={17} />Send</button><button onClick={() => openDrawer('receive')}><ArrowDownLeft size={17} />Receive</button></div><dl><dt>Network</dt><dd>{chain.name}</dd><dt>Token</dt><dd>{asset.name}</dd>{asset.address && <><dt>Contract</dt><dd>{asset.address}</dd></>}<dt>Exact balance</dt><dd>{hidden ? '••••' : asset.balance}</dd></dl></div>}
      {error && <p role="alert" className="error">{error}</p>}
    </Sheet>}
    {send && (family === 'evm' ? <EvmSendDialog initialToken={asset?.native === false ? asset.address : undefined} tokens={portfolio?.assets ?? []} nativeSymbol={chain.symbol} onClose={() => setSend(false)} onSent={() => { setSend(false); setTab('activity'); void refreshPortfolio(true); }} /> : <SendDialog accountId={account.id} family={family} chain={chain} onClose={() => setSend(false)} onSent={() => { setSend(false); setTab('activity'); void refreshPortfolio(true); }} />)}
  </main>;
}
function Action({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) { return <button disabled={disabled} onClick={onClick}>{icon}<span>{label}</span></button>; }
function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useDialogFocus<HTMLElement>(onClose), id = useId();
  return <div className="sheet-backdrop"><section ref={ref} className="wallet-sheet" role="dialog" aria-modal="true" aria-labelledby={id}><header className="page-bar"><button className="icon-button" aria-label="Close panel" onClick={onClose}><ArrowLeft size={21} /></button><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Dismiss panel" onClick={onClose}><X size={20} /></button></header><div className="sheet-content">{children}</div></section></div>;
}
function ReceiveAddress({ address, chain, copied, onCopy, protectedWallet, onProtect }: { address: string; chain: ChainInfo; copied: boolean; onCopy: () => void; protectedWallet: boolean; onProtect: () => void }) {
  const [qr, setQr] = useState('');
  useEffect(() => { let live = true; void QRCode.toDataURL(address, { width: 240, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#17181aff', light: '#ffffffff' } }).then(value => { if (live) setQr(value); }).catch(() => {}); return () => { live = false; }; }, [address]);
  return <div className="receive-content"><div className="receive-network"><img alt="" src={`chain-icons/${chain.icon}`} />{chain.name}</div><p>Only send assets on {chain.name} to this address.</p>{qr && <img className="receive-qr" alt={`Receive address QR code for ${chain.name}`} src={qr} />}<span className="field-caption">Your address</span><div className="receive-address">{address}</div><button className="primary" onClick={onCopy}>{copied ? <Check size={18} /> : <Copy size={18} />}{copied ? 'Copied' : 'Copy address'}</button>{!protectedWallet && <button className="backup-banner" onClick={onProtect}><ShieldCheck size={20} /><span><strong>Protect before receiving funds</strong><small>Set up a Passkey or password and back up.</small></span><ChevronRight size={17} /></button>}</div>;
}
