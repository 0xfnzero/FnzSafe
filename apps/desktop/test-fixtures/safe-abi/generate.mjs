// Generates frontend calldata plus independent expected receiver state for the Rust integration test.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {buildSafeAbiCall} from '../../src/lib/safeAbi.ts';
import {parseAbiJson,functionSignature} from '../../src/lib/evmAbi.ts';
const require=createRequire(import.meta.url);
const solc=require(process.env.SOLC_MODULE || 'solc');
const {Interface,AbiCoder,keccak256}=require(process.env.ABI_REFERENCE_MODULE || 'ethers');
const source=readFileSync(new URL('./Receiver.sol',import.meta.url),'utf8');
const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'Receiver.sol':{content:source}},settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.deployedBytecode.object']}}}})));
assert.equal((output.errors || []).filter(e=>e.severity==='error').length,0,JSON.stringify(output.errors));
const artifact=output.contracts['Receiver.sol'].Receiver;
const fn=parseAbiJson(JSON.stringify(artifact.abi)).find(f=>f.name==='record');
const iface=new Interface(artifact.abi);
function reference(p,value) {
  const m=p.type.match(/^(.*)\[(\d*)\]$/);
  if(m) return value.map(v=>reference({...p,type:m[1]},v));
  if(p.type==='tuple') return p.components.map((c,i)=>reference(c,value[i]));
  return p.type==='bool'?value==='true':value;
}
const address='0x'+'12'.repeat(20), zero='0x'+'00'.repeat(20);
const calls=[];
for(let i=0;i<12;i++) {
  const payload=[
    [0n,1n,(1n<<256n)-1n,90071992547409931234567890n][i%4].toString(),
    [-(1n<<127n),-1n,0n,(1n<<127n)-1n][i%4].toString(), i%2?'true':'false', i%2?address:zero,
    '0x'+i.toString(16).padStart(2,'0').repeat(32), ['', ' 汉字🙂\n ', 'quote"\\\u0000'][i%3],
    '0x'+'ab'.repeat([0,1,31,32,33,65][i%6]),
    i%2?['0','9007199254740993',((1n<<256n)-1n).toString()]:[],
    i%3?['0x','0x11','0x'+'33'.repeat(33)]:[],
    i%2?[[address,'false',''],[zero,'true',' 多签🙂 ']]:[],
    [(-(1n<<255n)).toString(),((1n<<255n)-1n).toString()], ['', '尾部🙂'],
  ];
  const args=[payload], data=buildSafeAbiCall(fn,args), raw=reference(fn.inputs[0],payload);
  assert.equal(data,iface.encodeFunctionData(functionSignature(fn),[raw]));
  calls.push({data,value:String(i*17),expected_hash:keccak256(AbiCoder.defaultAbiCoder().encode([fn.inputs[0]],[raw]))});
}
// Same tuple arguments with a nonpayable selector; attaching value must revert in simulation.
const nonpayableData='0x'+iface.getFunction('recordNoValue').selector.slice(2)+calls[0].data.slice(10);
writeFileSync(process.argv[2] || '/tmp/fnzsafe-safe-abi-fixture.json',JSON.stringify({compiler:solc.version(),runtime:'0x'+artifact.evm.deployedBytecode.object,calls,nonpayable_data:nonpayableData},null,2));
console.log(`Generated ${calls.length} Solidity-decoded Safe contract calls with independent expected hashes (${solc.version()}).`);
