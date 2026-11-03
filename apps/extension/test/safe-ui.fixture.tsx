// Synthetic UI fixture. Not an extension build entry; never reads wallet storage.
import {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SafeView} from '../src/ui/safe-view';
import {SettingsView} from '../src/ui/wallet-panels';
import {useLocale} from '../src/ui/i18n';
import type {WalletStatus} from '../src/ui/api';
import type {SafeProposal, SafeAccount} from '../src/safe';
import '../src/ui/styles.css';

const owner='0x1111111111111111111111111111111111111111';
const other='0x2222222222222222222222222222222222222222';
const addresses=['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'];
const info=(address:string):SafeAccount=>({address,chain_id:97,version:'1.4.1',owners:[owner,other],threshold:2,nonce:'0',balance_wei:'1000000000000000000'});
const initialStatus:WalletStatus={initialized:true,passwordProtected:true,passkey:null,backupConfirmed:true,locked:false,accounts:[],wallets:[],suggestedWalletName:'Fixture',settings:{autoLockMinutes:15,evmChainId:97,solanaCluster:'devnet',enhancedAssetDetection:true},chains:[{key:'evm:97',family:'evm',chainId:97,name:'BSC Testnet',symbol:'tBNB',rpcUrl:'https://rpc.example.test',icon:'',transactionSupport:true}],connectedOrigins:[],connectedSites:[{origin:'https://example.org',families:['evm'],accountCount:1,networkCount:1}]};
function Fixture(){
  useLocale();
  const [tab,setTab]=useState<'safe'|'settings'>('safe'),[status,setStatus]=useState(initialStatus),[notice,setNotice]=useState('');
  const [chain,setChain]=useState(97),[account,setAccount]=useState(owner),[version,setVersion]=useState(0);
  const stored=useRef<{safes:Array<{chainId:number;address:string;owners:string[]}>;proposals:SafeProposal[]}>({safes:[],proposals:[]});
  const fail=useRef(false);
  const [requests,setRequests]=useState({scan:0,account:0});
  Object.assign(window,{chrome:{runtime:{sendMessage:async (message:Record<string,unknown>)=>{
    if(message.type==='SAFE_DISCOVER')setRequests(r=>({...r,scan:r.scan+1}));
    if(message.type==='SAFE_ACCOUNT')setRequests(r=>({...r,account:r.account+1}));
    if(message.type==='SAFE_LIST')return {ok:true,result:structuredClone(stored.current)};
    await new Promise(resolve=>setTimeout(resolve,900));
    if(message.type==='SAFE_DISCOVER'){
      if(fail.current){fail.current=false;return {ok:false,error:'Simulated RPC failure'};}
      const final=message.before_block!==undefined;
      const accounts=chain===97&&account===owner?[info(addresses[final?1:0])]:[];
      for(const item of accounts)if(!stored.current.safes.some(s=>s.address===item.address))stored.current.safes.push({chainId:97,address:item.address,owners:item.owners});
      return {ok:true,result:{accounts,from_block:final?0:50001,to_block:final?50000:100000,latest_block:100000,next_before_block:final?null:50000,next_offset:0,block_span:50000,complete:final,unsupported:0}};
    }
    if(message.type==='SET_AUTO_LOCK'){setStatus(s=>({...s,settings:{...s.settings,autoLockMinutes:Number(message.minutes)}}));return {ok:true};}
    if(message.type==='SET_ENHANCED_ASSET_DETECTION'){setStatus(s=>({...s,settings:{...s.settings,enhancedAssetDetection:Boolean(message.enabled)}}));return {ok:true};}
    if(message.type==='REVOKE_PERMISSION'){setStatus(s=>({...s,connectedSites:[]}));return {ok:true};}
    if(message.type==='SET_RPC')return {ok:true};
    if(message.type==='SAFE_PROPOSE'){
      const p:SafeProposal={version:1,chain_id:97,safe_address:String(message.address),to:String(message.to),value:String(message.value),data:String(message.data),nonce:String(message.nonce),signatures:[],safe_tx_hash:'0x'+'a'.repeat(64)};
      stored.current.proposals.push(p);return {ok:true,result:p};
    }
    if(message.type==='SAFE_ACCOUNT'){const item=info(String(message.address));if(!stored.current.safes.some(s=>s.address===item.address))stored.current.safes.push({chainId:chain,address:item.address,owners:item.owners});return {ok:true,result:item};}
    return {ok:false,error:'This fixture only permits read-only Safe requests'};
  }}}});
  return <main className="shell wallet-shell"><div style={{padding:12,background:'#fff1c2',color:'#463000'}}>TEST ONLY · Synthetic Safe accounts<br/><output>Scan requests: {requests.scan} · Address requests: {requests.account}</output></div><details><summary>Fixture controls</summary><div style={{padding:12,display:'grid',gap:8}}>
    <button onClick={()=>{stored.current={safes:[],proposals:[]};setVersion(v=>v+1);}}>Clear fixture cache</button>
    <button onClick={()=>{fail.current=true;}}>Fail next scan</button>
    <select aria-label="Fixture network" value={chain} onChange={e=>setChain(Number(e.target.value))}><option value={97}>BSC Testnet</option><option value={56}>BSC Mainnet</option></select>
    <select aria-label="Fixture owner" value={account} onChange={e=>setAccount(e.target.value)}><option value={owner}>Owner</option><option value="0x3333333333333333333333333333333333333333">Other account</option></select>
  </div></details>{notice&&<p role="status">{notice}</p>}{tab==='safe'?<SafeView key={`${chain}:${account}:${version}`} chainId={chain} chainName={chain===97?'BSC Testnet':'BSC Mainnet'} accountId={account} accountAddress={account}/>:<SettingsView status={status} onRefresh={async()=>{}} onLock={async()=>setNotice('Fixture lock requested')} onSecurity={()=>setNotice('Fixture protection requested')} onManageWallets={()=>setNotice('Fixture accounts requested')} onImport={()=>setNotice('Fixture import requested')}/>}<nav><button onClick={()=>setTab('safe')}>Safe fixture</button><button onClick={()=>setTab('settings')}>Settings fixture</button></nav></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
