import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,solidityPacked} from 'ethers';
import {safeBatchPayload,validateSafeBatch,SAFE_MULTISEND_CALL_ONLY} from './safeBatch.ts';
import {parseSafeImport} from './safeTransactionImport.ts';
import {parseSafeProposal,assertSafeProposalMatches} from './safeMultisig.ts';
const a='0x'+'11'.repeat(20),b='0x'+'22'.repeat(20);
const calls=[{to:a,value:'9007199254740993',data:'0x12345678'},{to:b,value:'7',data:'0x'}];
test('official packed CALL encoding matches ethers and preserves one ordered batch',()=>{
 const payload=safeBatchPayload(calls);
 const packed='0x'+calls.map(c=>solidityPacked(['uint8','address','uint256','uint256','bytes'],[0,c.to,c.value,(c.data.length-2)/2,c.data]).slice(2)).join('');
 const expected=new Interface(['function multiSend(bytes transactions) payable']).encodeFunctionData('multiSend',[packed]);
 assert.equal(payload.data,expected);assert.equal(payload.to,SAFE_MULTISEND_CALL_ONLY);assert.equal(payload.value,'0');
 const imported=parseSafeImport(JSON.stringify({version:'1.0',chainId:'97',meta:{createdFromSafeAddress:a},transactions:calls}));
 assert.deepEqual(safeBatchPayload(imported.transactions),payload);
});
test('batch metadata cannot change recipients, values, order or operation interpretation',()=>{
 const payload=safeBatchPayload(calls),p={version:1,chain_id:97,safe_address:a,...payload,nonce:'5',safe_tx_hash:'0x'+'ab'.repeat(32),signatures:[]};
 assert.deepEqual(parseSafeProposal(JSON.stringify(p)),p);
 for(const change of [{to:a},{value:'1'},{data:'0x'},{batch:[...calls].reverse()},{batch:[{...calls[0],value:'1'},calls[1]]},{batch:null}])assert.throws(()=>validateSafeBatch({...payload,...change}));
 assert.throws(()=>assertSafeProposalMatches({...p,batch:undefined},p));
 assert.throws(()=>assertSafeProposalMatches(p,{...p,batch:undefined}));
});
test('batch bounds reject malformed and oversized calls rather than splitting or truncating',()=>{
 for(const list of [[],[calls[0]],Array(101).fill(calls[0]),[{...calls[0],operation:1},calls[1]],[{...calls[0],value:'01'},calls[1]],[{...calls[0],value:(2n**256n).toString()},calls[1]],[{...calls[0],data:'0x1'},calls[1]],[{...calls[0],data:'0x'+'aa'.repeat(65536)},calls[1]]])assert.throws(()=>safeBatchPayload(list));
 const large=safeBatchPayload([{...calls[0],data:'0x'+'ab'.repeat(50000)},calls[1]]);
 const p={version:1,chain_id:97,safe_address:a,...large,nonce:'0',safe_tx_hash:'0x'+'ab'.repeat(32),signatures:[]};
 assert.equal(parseSafeImport(JSON.stringify(p)).kind,'proposal','large signed batches remain importable');
});
