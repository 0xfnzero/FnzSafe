import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {BrowserProvider} from 'ethers';

const source=readFileSync(new URL('../../src-tauri/src/lib.rs',import.meta.url),'utf8');
const script=source.slice(source.indexOf('fn evm_dapp_provider_script(')).match(/let script = r#"([\s\S]*?)"#;/)[1];
const account='0x1111111111111111111111111111111111111111';
function fixture(read=async method=>method==='eth_blockNumber'?'0x123':method==='eth_estimateGas'?'0x7ee53e':null, options={}){
 let nativeNetwork=options.initialNetwork || 'eip155:97';
 const calls=[];
 const window={addEventListener(){},dispatchEvent(){},setTimeout(){},__TAURI_INTERNALS__:{async invoke(command,args){
  calls.push({command,args});
  if(command==='dapp_provider_network')return nativeNetwork.startsWith('eip155:')?nativeNetwork:'eip155:1';
  if(command==='dapp_switch_network'){
   if(!['eip155:1','eip155:97','mainnet'].includes(args.network))throw {code:4902,message:'Unknown network'};
   nativeNetwork=args.network;return nativeNetwork;
  }
  if(command==='dapp_submit_connect_request')return 'connect-id';
  if(command==='dapp_poll_connect_request')return {status:'approved',result:{public_key:options.approvedAccount || account}};
  if(command==='dapp_evm_rpc_request')return read(args.method,args.params);
  if(command==='dapp_submit_sign_request')return 'sign-id';
  if(command==='dapp_poll_sign_request')return {status:'rejected',result:{error:'User rejected the request'}};
  throw Error('Unexpected command '+command);
 }}};
 const replacements={__WALLET_ADDRESS__:account,__CHAIN_ID_HEX__:'0x61',__CHAIN_ID_DECIMAL__:'97',__WALLET_NAME__:'FnzSafe',__WALLET_ICON__:'data:image/png;base64,AA=='};
 const rendered=script.replace(/__WALLET_ADDRESS__|__CHAIN_ID_HEX__|__CHAIN_ID_DECIMAL__|__WALLET_NAME__|__WALLET_ICON__/g,key=>JSON.stringify(replacements[key]));
 vm.runInNewContext(rendered,{window,console,setTimeout,CustomEvent:class{},Event:class{}});
 return {wallet:window.ethereum,calls,nativeNetwork:()=>nativeNetwork};
}

test('ethers reaches wallet confirmation after block-number lookup and gas estimation',async()=>{
 const {wallet,calls}=fixture();
 await wallet.request({method:'eth_requestAccounts'});
 const provider=new BrowserProvider(wallet,undefined,{cacheTimeout:-1});
 try {
  const signer=await provider.getSigner();
  await assert.rejects(signer.sendTransaction({to:'0x2222222222222222222222222222222222222222',data:'0x1234'}),e=>e.code==='ACTION_REJECTED');
  const reads=calls.filter(c=>c.command==='dapp_evm_rpc_request').map(c=>c.args.method);
  assert.ok(reads.includes('eth_blockNumber'));
  assert.ok(reads.includes('eth_estimateGas'));
  const send=calls.find(c=>c.command==='dapp_submit_sign_request');
  assert.equal(send.args.method,'eth_sendTransaction');
  const tx=JSON.parse(send.args.payloadJson).params[0];
  assert.equal(tx.from.toLowerCase(),account);assert.equal(BigInt(tx.gas),8316222n);
 }finally{provider.destroy()}
});

test('pending receipts and RPC revert codes/data are preserved through ethers',async()=>{
 const {wallet}=fixture(async method=>{
  if(method==='eth_getTransactionReceipt')return null;
  throw {code:3,message:'execution reverted',data:'0x12345678'};
 });
 const provider=new BrowserProvider(wallet);
 try {
  assert.equal(await provider.getTransactionReceipt('0x'+'ab'.repeat(32)),null);
  await assert.rejects(provider.estimateGas({from:account,to:account}),e=>e.code==='CALL_EXCEPTION'&&e.data==='0x12345678');
 }finally{provider.destroy()}
});

test('unsupported administrative and raw-send requests never enter the native read bridge',async()=>{
 const {wallet,calls}=fixture();
 for(const method of ['admin_peers','debug_traceCall','eth_sendRawTransaction','eth_newFilter']) {
  await assert.rejects(wallet.request({method,params:[]}),e=>e.code===4200);
 }
 assert.equal(calls.length,0);
});


test('BSC Testnet request switches a Solana session and returns only its EVM account',async()=>{
 const {wallet,calls,nativeNetwork}=fixture(undefined,{initialNetwork:'mainnet'});
 const changed=[];
 wallet.on('chainChanged',chain=>changed.push(chain));
 assert.equal(await wallet.request({method:'eth_chainId'}),'0x1');
 assert.equal(nativeNetwork(),'mainnet','provider discovery must not change the selected chain');
 assert.deepEqual(Array.from(await wallet.request({method:'eth_accounts'})),[]);
 await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x61'}]});
 assert.equal(nativeNetwork(),'eip155:97');
 assert.equal(await wallet.request({method:'eth_chainId'}),'0x61');
 assert.equal(await wallet.request({method:'net_version'}),'97');
 assert.deepEqual(Array.from(await wallet.request({method:'eth_requestAccounts'})),[account]);
 assert.equal(wallet.selectedAddress,account);
 assert.ok(changed.includes('0x61'));
 const connect=calls.find(c=>c.command==='dapp_submit_connect_request');
 assert.equal(connect.args.expectedFamily,'evm');
 assert.equal(connect.args.expectedNetwork,'eip155:97');
 await assert.rejects(wallet.request({method:'personal_sign',params:['0x6869',account]}),e=>e.code===4001);
 const sign=calls.find(c=>c.command==='dapp_submit_sign_request');
 assert.equal(sign.args.expectedNetwork,'eip155:97');
 assert.equal(sign.args.expectedFamily,'evm');
});

test('unknown or malformed chain requests preserve the current network',async()=>{
 const {wallet,nativeNetwork}=fixture();
 await assert.rejects(wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x9999'}]}),e=>e.code===4902);
 for(const chainId of ['97','0x0','0xnope','0xffffffffffffffff']){
  await assert.rejects(wallet.request({method:'wallet_switchEthereumChain',params:[{chainId}]}),e=>e.code===-32602);
 }
 assert.equal(nativeNetwork(),'eip155:97');
 assert.equal(await wallet.request({method:'eth_chainId'}),'0x61');
});

test('known add-chain requests ignore site-provided RPC endpoints',async()=>{
 const {wallet,calls}=fixture();
 await wallet.request({method:'wallet_addEthereumChain',params:[{chainId:'0x1',rpcUrls:['https://untrusted.invalid']} ]});
 const change=calls.find(c=>c.command==='dapp_switch_network');
 assert.deepEqual(JSON.parse(JSON.stringify(change.args)),{network:'eip155:1'});
 assert.equal(await wallet.request({method:'eth_chainId'}),'0x1');
});

test('an accidental Solana approval cannot become an EVM account',async()=>{
 const {wallet}=fixture(undefined,{approvedAccount:'11111111111111111111111111111111'});
 await assert.rejects(wallet.request({method:'eth_requestAccounts'}),e=>e.code===-32603);
 assert.equal(wallet.selectedAddress,null);
 assert.deepEqual(Array.from(await wallet.request({method:'eth_accounts'})),[]);
});

test('switching EVM networks preserves the account and reauthorizes the new signing context',async()=>{
 const {wallet,calls}=fixture();
 await wallet.request({method:'eth_requestAccounts'});
 await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1'}]});
 assert.deepEqual(Array.from(await wallet.request({method:'eth_accounts'})),[account]);
 assert.equal(wallet.selectedAddress,account);
 await assert.rejects(wallet.request({method:'personal_sign',params:['0x6869',account]}),e=>e.code===4001);
 const connects=calls.filter(c=>c.command==='dapp_submit_connect_request');
 assert.deepEqual(connects.map(c=>c.args.expectedNetwork),['eip155:97','eip155:1']);
 assert.equal(calls.find(c=>c.command==='dapp_submit_sign_request').args.expectedNetwork,'eip155:1');
});
