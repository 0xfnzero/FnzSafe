// Independent oracle; ABI_REFERENCE_MODULE may point to an existing ethers v6 installation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { functionSignature } from './evmAbi.ts';
import { buildSafeAbiCall } from './safeAbi.ts';
const {Interface} = createRequire(import.meta.url)(process.env.ABI_REFERENCE_MODULE || 'ethers');
const fn = inputs => ({type:'function', name:'verify', inputs, outputs:[], stateMutability:'nonpayable'});
const param = (type, components) => ({name:'',type,...(components ? {components} : {})});
function referenceValue(p, v) {
  const m=p.type.match(/^(.*)\[(\d*)\]$/);
  if(m) return v.map(x=>referenceValue({...p,type:m[1]},x));
  if(p.type==='tuple') return p.components.map((c,i)=>referenceValue(c,v[i]));
  return p.type==='bool' ? v==='true' : v;
}
function compare(inputs, args) {
  const method=fn(inputs);
  const iface=new Interface([method]);
  const expected=iface.encodeFunctionData(functionSignature(method),inputs.map((p,i)=>referenceValue(p,args[i])));
  assert.equal(buildSafeAbiCall(method,args),expected,JSON.stringify({inputs,args}));
}
test('ethers v6 oracle: every Solidity integer width at signed and unsigned boundaries', () => {
  for(let bits=8;bits<=256;bits+=8) {
    const u=param(`uint${bits}`), s=param(`int${bits}`);
    for(const n of [0n,1n,(1n<<BigInt(bits))-1n]) compare([u],[n.toString()]);
    for(const n of [-(1n<<BigInt(bits-1)),-1n,0n,(1n<<BigInt(bits-1))-1n]) compare([s],[n.toString()]);
    for(const n of [-1n,1n<<BigInt(bits)]) assert.throws(()=>buildSafeAbiCall(fn([u]),[n.toString()]));
    for(const n of [-(1n<<BigInt(bits-1))-1n,1n<<BigInt(bits-1)]) assert.throws(()=>buildSafeAbiCall(fn([s]),[n.toString()]));
  }
});
test('ethers v6 oracle: bytes1..bytes32, byte lengths across word boundaries and UTF-8', () => {
  for(let n=1;n<=32;n++) compare([param(`bytes${n}`)],['0x'+'ab'.repeat(n)]);
  for(const n of [0,1,2,31,32,33,63,64,65,127,128,129]) compare([param('bytes'),param('string')],['0x'+'ff'.repeat(n),'汉🙂'.repeat(n)]);
  for(const value of ['', '  spaces  ', 'line\nnext\tend', 'quote " and slash \\', '\u0000']) compare([param('string')],[value]);
});
let state=0x404141;
function random(n) { state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n; }
function generated(depth=0) {
  const choice=random(depth<3?10:6);
  if(choice===0) return [param('uint256'),((BigInt(random(0xffffffff))<<128n)+BigInt(random(0xffffffff))).toString()];
  if(choice===1) return [param('int256'),(-BigInt(random(0xffffffff))).toString()];
  if(choice===2) return [param('bool'),random(2)?'true':'false'];
  if(choice===3) return [param('address'),'0x'+random(0xffffff).toString(16).padStart(40,'0')];
  if(choice===4) return [param('bytes'),'0x'+'a3'.repeat(random(70))];
  if(choice===5) return [param('string'),['','hello','汉字🙂',' spaces ','comma,quote"'][random(5)]];
  if(choice===6 || choice===7) {
    const [child,value]=generated(depth+1), count=random(4), fixed=choice===7;
    const length=fixed?count+1:count;
    return [{...child,type:child.type+`[${fixed?length:''}]`},Array.from({length},()=>value)];
  }
  const children=Array.from({length:1+random(3)},()=>generated(depth+1));
  return [param('tuple',children.map(c=>c[0])),children.map(c=>c[1])];
}
test('ethers v6 oracle: 1000 seeded nested tuple/array and dynamic-offset combinations', () => {
  for(let i=0;i<1000;i++) {
    const values=Array.from({length:1+random(5)},()=>generated());
    compare(values.map(v=>v[0]),values.map(v=>v[1]));
  }
});
