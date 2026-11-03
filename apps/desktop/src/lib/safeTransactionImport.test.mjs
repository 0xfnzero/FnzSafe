import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseSafeImport,safeImportTarget} from './safeTransactionImport.ts';
const safe='0x'+'11'.repeat(20),target='0x'+'22'.repeat(20);
const tx={to:target,value:'0',data:'0x12345678',contractMethod:null,contractInputsValues:null};
const file={version:'1.0',chainId:'97',createdAt:123,meta:{createdFromSafeAddress:safe,name:'X404'},transactions:[tx]};
const parse=value=>parseSafeImport(JSON.stringify(value));

test('reads raw Transaction Builder scheduling and execution payloads without changing the CALL',()=>{
 for(const data of ['0x2436857e'+'00'.repeat(512),'0xe38335e5'+'ab'.repeat(512)]){
  const imported=parse({...file,transactions:[{...tx,data}]});
  assert.equal(imported.kind,'transactions');assert.equal(imported.safeAddress,safe);
  assert.equal(safeImportTarget(imported,97,safe),safe);
  assert.deepEqual(imported.transactions,[{to:target,value:'0',data}]);
 }
});

test('generated transaction payloads retain exact uint256 values, addresses and bytes across metadata changes',()=>{
 // Repeatable generated inputs exercise the invariant without another test dependency.
 for(let i=0;i<256;i++){
  const hash=createHash('sha256').update(`safe-import-${i}`).digest('hex');
  const value=BigInt('0x'+hash).toString(),to='0x'+hash.slice(0,40),data='0x'+hash.repeat(i%9);
  const expected={to,value,data},input={...file,transactions:[{...expected,contractMethod:null,contractInputsValues:null}]};
  assert.deepEqual(parse(input).transactions,[expected],`payload ${i}`);
  input.meta={...input.meta,name:'untrusted label',description:'transfer something else'};
  assert.deepEqual(parse(input).transactions,[expected],`metadata ${i}`);
 }
 assert.equal(parse({...file,transactions:[{...tx,value:(2n**256n-1n).toString()}]}).transactions[0].value,(2n**256n-1n).toString());
});

test('rejects unsupported operations, refunds, malformed quantities, calldata and wrong types',()=>{
 for(const patch of [{operation:1},{operation:'0'},{safeTxGas:'100'},{refundReceiver:safe},{value:1},{value:'-1'},{value:'1e18'},{value:'01'},{value:(2n**256n).toString()},{data:'0x1'},{data:17},{to:'0x'+'00'.repeat(20)},{data:'0x'+'aa'.repeat(65537)}]){
  assert.throws(()=>parse({...file,transactions:[{...tx,...patch}]}),JSON.stringify(patch).slice(0,100));
 }
 for(const patch of [{version:1},{version:'2.0'},{chainId:97},{chainId:'97.1'},{chainId:'9007199254740993'},{transactions:[]},{transactions:[null]},{transactions:Array(101).fill(tx)}])assert.throws(()=>parse({...file,...patch}));
 assert.throws(()=>parseSafeImport('{'));
 assert.throws(()=>parseSafeImport(' '.repeat(400001)));
});

test('validates every transaction and preserves file order for subsequent atomic batch construction',()=>{
 const transactions=[tx,{...tx,to:safe,value:'9007199254740993',data:'0x'}];
 assert.deepEqual(parse({...file,transactions}).transactions,transactions.map(({to,value,data})=>({to,value,data})));
 assert.throws(()=>parse({...file,transactions:[tx,{...tx,operation:1}]}));
});

test('never switches network or substitutes the Safe specified by the file',()=>{
 const input=parse(file);
 assert.throws(()=>safeImportTarget(input,56,safe),/wrongNetwork/);
 assert.throws(()=>safeImportTarget(input,97,target),/wrongImportSafe/);
 assert.equal(safeImportTarget(input,97,''),safe);
 const unspecified=parse({...file,meta:{}});
 assert.throws(()=>safeImportTarget(unspecified,97,''),/importSafeRequired/);
 assert.equal(safeImportTarget(unspecified,97,target),target);
});

test('encodes standard ABI-only Transaction Builder files when raw calldata is absent',()=>{
 const method={name:'setPublicCreationEnabled',inputs:[{name:'enabled',type:'bool'}],payable:false};
 const abiTx={...tx,data:null,contractMethod:method,contractInputsValues:{enabled:'true'}};
 const encoded=parse({...file,transactions:[abiTx]}).transactions[0].data;
 assert.equal(encoded.length,74);assert.ok(encoded.endsWith('0'.repeat(63)+'1'));
 assert.throws(()=>parse({...file,transactions:[{...abiTx,value:'1'}]}),/invalidImportMethod/);
 assert.throws(()=>parse({...file,transactions:[{...abiTx,contractInputsValues:{}}]}),/invalidImportMethod/);
 assert.deepEqual(parse({...file,transactions:[{to:target,value:'5',data:null,contractMethod:null,contractInputsValues:null}]}).transactions,[{to:target,value:'5',data:'0x'}]);
 // Raw bytes remain authoritative even when unverified ABI metadata is attached.
 assert.equal(parse({...file,transactions:[{...abiTx,data:'0x11223344'}]}).transactions[0].data,'0x11223344');
 const arrayTx={...abiTx,contractMethod:{name:'test',inputs:[{name:'amounts',type:'uint256[]'}]},contractInputsValues:{amounts:'[9007199254740993]'}};
 assert.throws(()=>parse({...file,transactions:[arrayTx]}),/invalidImportMethod/);
 const stringTx={...abiTx,contractMethod:{name:'test',inputs:[{name:'text',type:'string'}]},contractInputsValues:{text:'\ud800'}};
 assert.throws(()=>parse({...file,transactions:[stringTx]}),/invalidImportMethod/);
 assert.doesNotThrow(()=>parse({...file,transactions:[{...arrayTx,contractInputsValues:{amounts:'["9007199254740993",1]'}}]}));
});

test('continues accepting complete FnzSafe signature exchanges without inventing a nonce or hash',()=>{
 const proposal={version:1,chain_id:97,safe_address:safe,...tx,nonce:'9007199254740993',safe_tx_hash:'0x'+'aa'.repeat(32),signatures:[]};
 delete proposal.contractMethod;delete proposal.contractInputsValues;
 assert.deepEqual(parse(proposal),{kind:'proposal',proposal});
 assert.throws(()=>parse({...proposal,operation:1}));
});
