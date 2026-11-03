import {t} from './i18n';
import {ArrowLeft, Plus, Search, ShieldCheck, FileSignature, RefreshCw, LoaderCircle, ChevronRight, Download, Upload} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {formatUnits, parseUnits} from 'ethers';
import type {SafeAccount, SafeProposal} from '../safe';
import {useSafeDiscovery} from './use-safe-discovery';
import type {SafeDiscoveryPage} from '../../../desktop/src/lib/safeMultisig';
import {parseSafeImport} from '../safe-import';
import {api, compact} from './api';
import {ReviewDialog, type TransactionReview} from './transactions';

type View = 'list' | 'account' | 'add' | 'create' | 'propose' | 'import' | 'transaction';
export function SafeView({chainId, chainName, accountId, accountAddress}: {chainId:number; chainName?:string; accountId?:string; accountAddress?:string}) {
  const [workspace,setWorkspace]=useState<{safes:Array<{chainId:number;address:string;owners?:string[]}>;proposals:SafeProposal[]}>({safes:[],proposals:[]});
  const [view,setView]=useState<View>('list'),[back,setBack]=useState<View>('list');
  const [address,setAddress]=useState(''),[account,setAccount]=useState<SafeAccount|null>(null);
  const [owners,setOwners]=useState(accountAddress||''),[threshold,setThreshold]=useState('2');
  const [to,setTo]=useState(''),[amount,setAmount]=useState('0'),[data,setData]=useState('0x'),[nonce,setNonce]=useState('');
  const [importText,setImportText]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [review,setReview]=useState<TransactionReview|null>(null),[selected,setSelected]=useState<SafeProposal|null>(null);
  const [accountLoading,setAccountLoading]=useState(false),[showAll,setShowAll]=useState(false),[search,setSearch]=useState('');
  const [accountTab,setAccountTab]=useState<'transactions'|'owners'>('transactions');
  const active=useRef(true),lock=useRef(false),heading=useRef<HTMLHeadingElement>(null),root=useRef<HTMLElement>(null);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{root.current?.scrollTo({top:0});heading.current?.focus({preventScroll:true});},[view]);
  async function read<T>(input:Record<string,unknown>,milliseconds=30_000):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([api<T>(input),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('RPC timed out. Retry the read.')),milliseconds);})]);}
    finally{clearTimeout(timer);}
  }
  async function load(){const saved=await read<typeof workspace>({type:'SAFE_LIST'});if(active.current)setWorkspace(saved);}
  useEffect(()=>{setView('list');setAccount(null);setReview(null);setSelected(null);void load().catch(()=>setError('Unable to load saved Safes'));},[chainId,accountId]);
  const discovery=useSafeDiscovery({scope:`${chainId}:${accountId}`,enabled:!!accountId,
    request:async cursor=>{const result=await read<SafeDiscoveryPage>({type:'SAFE_DISCOVER',...cursor},90_000);await load();return result;},onAccounts:()=>{},
  });
  function navigate(next:View,parent:View='list'){setView(next);setBack(parent);setError('');setMessage('');}
  async function run(action:()=>Promise<void>){
    if(lock.current)return;lock.current=true;setBusy(true);setMessage('');setError('');
    try{await action();await load();}catch(e){if(active.current)setError(e instanceof Error?e.message:'Safe operation failed');}
    finally{lock.current=false;if(active.current)setBusy(false);}
  }
  async function openSafe(value:string){
    setAddress(value);setAccount(null);setAccountLoading(true);setTo('');setAmount('0');setData('0x');setAccountTab('transactions');navigate('account');
    try{const info=await read<SafeAccount>({type:'SAFE_ACCOUNT',address:value});if(active.current){setAddress(info.address);setAccount(info);setNonce(info.nonce);}}
    finally{if(active.current)setAccountLoading(false);}
  }
  function importFrom(parent:View){if(parent==='list'){setAccount(null);setAddress('');}setImportText('');navigate('import',parent);}
  async function importProposal(){
    const file=parseSafeImport(importText);
    if(file.kind==='proposal'&&account&&file.proposal.safe_address.toLowerCase()!==account.address.toLowerCase())throw new Error('The file names a different Safe account');
    const p=await api<SafeProposal>(file.kind==='transactions'?{type:'SAFE_IMPORT_TRANSACTIONS',file:importText,address:account?.address||address.trim()}:{type:'SAFE_IMPORT',proposal:importText});
    await openSafe(p.safe_address);setSelected(p);navigate('transaction','account');setMessage('Proposal validated and saved');
  }
  const saved=workspace.safes.filter(s=>s.chainId===chainId&&(showAll||!s.owners||s.owners.some(o=>o.toLowerCase()===accountAddress?.toLowerCase())));
  const visible=saved.filter(s=>s.address.toLowerCase().includes(search.trim().toLowerCase()));
  const proposals=workspace.proposals.filter(p=>p.chain_id===chainId&&p.safe_address.toLowerCase()===account?.address.toLowerCase());
  const proposal=workspace.proposals.find(p=>p.chain_id===selected?.chain_id&&p.safe_tx_hash===selected?.safe_tx_hash)||selected;
  const titles:Record<View,string>={list:'Safe multisig',account:'Safe account',add:'Add existing Safe',create:'Create Safe',propose:'New proposal',import:'Import proposal / Transaction Builder',transaction:'Proposal details'};
  return <section ref={root} className="safe-view safe-flow">
    <header className="flow-header">{view!=='list'&&<button className="icon-button" aria-label={t('Back')} disabled={busy} onClick={()=>navigate(back)}><ArrowLeft size={20}/></button>}<div><h2 ref={heading} tabIndex={-1}>{t(titles[view])}</h2><p>{chainName && <>{chainName} · </>}{view==='list'?t('Your shared wallets, in one place.'):account?compact(account.address):t('SAFE MULTISIG · EVM')}</p></div>{view==='list'&&<ShieldCheck size={25}/>}</header>
    {error&&<p role="alert" className="error">{t(error)}</p>}{message&&<p role="status" className="success-note">{t(message)}</p>}
    {busy&&<div role="status" className="safe-operation"><LoaderCircle size={18} className="spin"/>{t(accountLoading?'Loading Safe details…':'Checking Safe operation…')}</div>}
    {view==='list'&&<>
      <div className="safe-sync settings-panel"><div className="safe-sync-heading"><RefreshCw size={15} className={discovery.status==='running'?'spin':''}/><strong>{t(discovery.status==='running'?'Scanning onchain Safes':discovery.status==='complete'?'Factory scan complete':discovery.status==='error'?'Scan interrupted':discovery.status==='paused'?'Scan paused':'Sync onchain Safes')}</strong>{discovery.status==='running'?<button onClick={discovery.pause}>{t('Pause')}</button>:<button onClick={()=>void discovery.start(discovery.status==='complete'||discovery.status==='idle')}>{t(discovery.status==='paused'||discovery.status==='error'?'Continue scan':'Sync')}</button>}</div>
        {discovery.page?<progress aria-label={t('History scan progress')} max={discovery.page.latest_block+1} value={discovery.page.latest_block-(discovery.page.next_before_block??-1)}/>:discovery.status==='running'&&<div className="safe-loading-bar"/>}
        <details className="sync-details"><summary>{t('Sync details')}{discovery.page&&` · ${t('Found: {count}',{count:discovery.count})}`}</summary><p className="fine-print">{t('Recover Safe 1.4.1 accounts from the canonical factory, newest first. Older accounts may take longer. Other factories require adding the address.')}</p>{discovery.page&&<p className="fine-print">{discovery.page.from_block.toLocaleString()}–{discovery.page.to_block.toLocaleString()}</p>}{discovery.unsupported>0&&<p className="fine-print">{t('Incompatible contracts were skipped.')}</p>}{['paused','error'].includes(discovery.status)&&discovery.page&&<button onClick={()=>void discovery.start(true)}>{t('Restart from latest block')}</button>}</details>
        {discovery.error&&<p role="alert" className="error">{t('Scan incomplete. Cached accounts remain available. Retry or change RPC.')} {t(discovery.error)}</p>}
      </div>
      <div className="flow-actions"><button className="primary" onClick={()=>{setAccount(null);setOwners(accountAddress||'');navigate('create');}}><Plus size={16}/>{t('Create Safe')}</button><button onClick={()=>{setAddress('');setAccount(null);navigate('add');}}><Download size={16}/>{t('Add existing Safe')}</button></div>
      <div className="list-heading"><h3>{t('Saved accounts')} <span>{saved.length}</span></h3><button className="text-button" onClick={()=>importFrom('list')}><Upload size={14}/>{t('Import')}</button></div>
      {saved.length>0&&<label className="search-field"><Search size={16}/><input aria-label={t('Search Safe address')} placeholder={t('Search Safe address')} value={search} onChange={e=>setSearch(e.target.value)}/></label>}
      <label className="check-label safe-filter"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/>{t('Show all saved Safes')}</label>
      <div className="saved-safes safe-cards">{visible.map(s=><button key={s.address} onClick={()=>void run(()=>openSafe(s.address))}><ShieldCheck size={20}/><span><strong>{compact(s.address)}</strong><small>{s.owners?t('{count} owners',{count:s.owners.length}):t('Saved account')}</small></span><ChevronRight size={16}/></button>)}</div>
      {!saved.length&&discovery.status==='running'&&<div className="token-skeleton" aria-label={t('Loading Safe details…')}><i/><i/></div>}
      {!visible.length&&discovery.status!=='running'&&<div className="empty"><ShieldCheck size={28}/><strong>{t(search?'No matching Safes':'No cached Safes yet')}</strong><span>{t('Complete the chain scan or add a Safe address.')}</span></div>}
    </>}
    <fieldset className="safe-controls" disabled={busy} aria-busy={busy}>
      {view==='add'&&<form className="flow-form" onSubmit={e=>{e.preventDefault();void run(()=>openSafe(address));}}><p>{t('Enter the Safe contract address on the selected network.')}</p><label>{t('Safe address')}<input value={address} onChange={e=>setAddress(e.target.value)} required/></label><button className="primary">{t('Open Safe')}</button></form>}
      {view==='create'&&<form className="flow-form" onSubmit={e=>{e.preventDefault();void run(async()=>{setReview(await api({type:'SAFE_PREPARE_CREATE',owners:owners.split(/[\s,;]+/).filter(Boolean),threshold:Number(threshold),salt:BigInt('0x'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')).toString()}));});}}><p>{t('Choose the owners and required approvals. Review the network fee before creating your Safe.')}</p><label>{t('Owner addresses')}<textarea value={owners} onChange={e=>setOwners(e.target.value)} rows={5} required/><small>{t('One owner address per line. At least two owners.')}</small></label><label>{t('Required signatures')}<input type="number" min={2} max={50} value={threshold} onChange={e=>setThreshold(e.target.value)} required/></label><button className="primary">{t('Preview Safe creation')}</button></form>}
      {view==='account'&&<>{accountLoading?<div className="token-skeleton"><i/><i/><i/></div>:!account?<button onClick={()=>void run(()=>openSafe(address))}>{t('Retry')}</button>:<>
        <div className="safe-account-summary"><code>{account.address}</code><strong>{formatUnits(account.balance_wei,18)} {t('native')}</strong><div><span>{account.threshold} / {account.owners.length} {t('signatures')}</span><button className="icon-button" aria-label={t('Refresh Safe')} onClick={()=>void run(()=>openSafe(account.address))}><RefreshCw size={16}/></button></div></div>
        <div className="flow-actions"><button className="primary" onClick={()=>navigate('propose','account')}><Plus size={16}/>{t('New proposal')}</button><button onClick={()=>importFrom('account')}><Upload size={16}/>{t('Import')}</button></div>
        <div className="flow-tabs" role="tablist" aria-label={t('Safe account sections')}><button role="tab" aria-selected={accountTab==='transactions'} onClick={()=>setAccountTab('transactions')}>{t('Proposals')} ({proposals.length})</button><button role="tab" aria-selected={accountTab==='owners'} onClick={()=>setAccountTab('owners')}>{t('Owners')} ({account.owners.length})</button></div>
        {accountTab==='owners'?<div className="settings-panel"><p className="fine-print">{t('Required signatures')}: {account.threshold} · {t('Safe nonce')}: {account.nonce}</p>{account.owners.map((owner,index)=><div className="owner-row" key={owner}><span>{index+1}</span><code>{owner}</code></div>)}</div>:<>{!proposals.length&&<div className="empty"><FileSignature size={28}/><strong>{t('All clear for now')}</strong><span>{t('Your shared transactions will appear here.')}</span></div>}<div className="proposal-list">{proposals.map(p=><button key={p.safe_tx_hash} onClick={()=>{setSelected(p);navigate('transaction','account');}}><FileSignature size={19}/><span><strong>{t('Nonce')} {p.nonce}{p.batch?` · ${t('Batch · {count} calls',{count:p.batch.length})}`:''}</strong><small>{p.signatures.length} / {account.threshold} {t('signatures')} · {compact(p.to)}</small></span><ChevronRight size={16}/></button>)}</div></>}
      </>}</>}
      {view==='propose'&&account&&<form className="flow-form" onSubmit={e=>{e.preventDefault();void run(async()=>{const p=await api<SafeProposal>({type:'SAFE_PROPOSE',address:account.address,to,value:parseUnits(amount,18).toString(),data,nonce});setSelected(p);navigate('transaction','account');setMessage('Proposal validated and saved');});}}><label>{t('Recipient / contract')}<input value={to} onChange={e=>setTo(e.target.value)} required/></label><label>{t('Native amount')}<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><details className="advanced-fields"><summary>{t('Advanced transaction fields')}</summary><label>{t('Calldata (hex)')}<textarea value={data} onChange={e=>setData(e.target.value)} maxLength={131074} required/></label><label>{t('Safe nonce')}<input inputMode="numeric" value={nonce} onChange={e=>setNonce(e.target.value)} required/></label><p className="fine-print">{t('Use 0x for a native transfer. Contract calls require the exact ABI-encoded calldata. Operation is always CALL; gas refunds are disabled.')}</p></details><button className="primary">{t('Save proposal')}</button></form>}
      {view==='import'&&<form className="flow-form" onSubmit={e=>{e.preventDefault();void run(importProposal);}}><p>{t('Import signed proposals or a Transaction Builder file. Review every call before signing.')}</p>{!account&&<label>{t('Safe address')}<input placeholder="0x…" value={address} onChange={e=>setAddress(e.target.value)}/><small>{t('Required only when the file does not include a Safe address.')}</small></label>}<label>{t('Proposal file')}<input type="file" accept=".json" onChange={async e=>{try{const file=e.target.files?.[0];if(!file)return;if(file.size>400000)throw new Error('Proposal exceeds size limit');setImportText(await file.text());setError('');}catch(e){setError(e instanceof Error?e.message:'Invalid Safe transaction file');}}}/></label><label>{t('Proposal JSON')}<textarea rows={7} maxLength={400000} value={importText} onChange={e=>setImportText(e.target.value)} required/></label><button className="primary">{t('Validate & import')}</button></form>}
      {view==='transaction'&&proposal&&<><div className="settings-panel"><h3>{t('Nonce')} {proposal.nonce}</h3><p>{proposal.signatures.length} / {account?.threshold||'—'} {t('signatures')}</p><p>{t('To:')} <code>{proposal.to}</code></p><p>{t('Value:')} {formatUnits(proposal.value,18)} {t('native')}</p>{proposal.batch&&<div className="safe-batch"><strong>{t('Batch · {count} calls',{count:proposal.batch.length})}</strong>{proposal.batch.map((call,index)=><div key={index}><span>{index+1}. <code>{call.to}</code></span><small>{call.value} wei</small><code>{call.data}</code></div>)}</div>}<details><summary>{t('Full proposal')}</summary><pre className="review-data">{JSON.stringify(proposal,null,2)}</pre></details></div><div className="flow-actions"><button className="primary" onClick={()=>void run(async()=>setReview(await api({type:'SAFE_PREPARE_SIGN',proposal:JSON.stringify(proposal)})))}>{t('Review & sign')}</button><button onClick={()=>void run(async()=>setReview(await api({type:'SAFE_PREPARE_EXECUTE',proposal:JSON.stringify(proposal)})))}>{t('Preview execution')}</button></div><button className="secondary-wide" onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(proposal,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`safe-${proposal.nonce}-${proposal.safe_tx_hash.slice(2,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}}><Download size={16}/>{t('Export JSON')}</button></>}
    </fieldset>
    {review&&<ReviewDialog review={review} onClose={()=>setReview(null)} onDone={async result=>{const created=review.kind==='safe-create';setReview(null);await load();if(created)navigate('list');setMessage(result.hash?`Submitted: ${result.hash}. Check the receipt in Activity.`:'Signature added. Export the proposal to share it.');}}/>}
  </section>;
}
