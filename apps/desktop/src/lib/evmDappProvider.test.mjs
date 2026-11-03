import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {BrowserProvider} from 'ethers';

const source=readFileSync(new URL('../../src-tauri/src/lib.rs',import.meta.url),'utf8');
const script=source.slice(source.indexOf('fn evm_dapp_provider_script(')).match(/let script = r#"([\s\S]*?)"#;/)[1];
const account='0x1111111111111111111111111111111111111111';
function fixture(read=async method=>method==='eth_blockNumber'?'0x123':method==='eth_estimateGas'?'0x7ee53e':null){
 const calls=[];
 const window={addEventListener(){},dispatchEvent(){},setTimeout(){},__TAURI_INTERNALS__:{async invoke(command,args){
  calls.push({command,args});
  if(command==='dapp_submit_connect_request')return 'connect-id';
  if(command==='dapp_poll_connect_request')return {status:'approved',result:{public_key:account}};
  if(command==='dapp_evm_rpc_request')return read(args.method,args.params);
  if(command==='dapp_submit_sign_request')return 'sign-id';
  if(command==='dapp_poll_sign_request')return {status:'rejected',result:{error:'User rejected the request'}};
  throw Error('Unexpected command '+command);
 }}};
 const replacements={__WALLET_ADDRESS__:account,__CHAIN_ID_HEX__:'0x61',__CHAIN_ID_DECIMAL__:'97',__WALLET_NAME__:'FnzSafe',__WALLET_ICON__:'data:image/png;base64,AA=='};
 const rendered=script.replace(/__WALLET_ADDRESS__|__CHAIN_ID_HEX__|__CHAIN_ID_DECIMAL__|__WALLET_NAME__|__WALLET_ICON__/g,key=>JSON.stringify(replacements[key]));
 vm.runInNewContext(rendered,{window,console,setTimeout,CustomEvent:class{},Event:class{}});
 return {wallet:window.ethereum,calls};
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
