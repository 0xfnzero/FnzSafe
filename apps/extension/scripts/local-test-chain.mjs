// Local synthetic fixtures only. Never use the public test phrase for real funds.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ContractFactory, HDNodeWallet, JsonRpcProvider } from 'ethers';
const binary = process.env.ANVIL_BIN, artifacts = process.env.SAFE_ARTIFACTS_DIR;
if (!binary || !artifacts) throw new Error('Set ANVIL_BIN and SAFE_ARTIFACTS_DIR');
const child = spawn(binary, ['--host','127.0.0.1','--port','18545','--chain-id','1','--silent'], {stdio:'ignore'});
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
const provider = new JsonRpcProvider('http://127.0.0.1:18545',1,{staticNetwork:true,cacheTimeout:-1});
try {
  for(let i=0;i<100;i++){try{await provider.send('eth_chainId',[]);break;}catch{await new Promise(r=>setTimeout(r,100));}}
  for(const [address,path] of [['0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67','proxies/SafeProxyFactory.sol/SafeProxyFactory.json'],['0x41675c099f32341bf84bfc5382af534df5c7461a','Safe.sol/Safe.json']]) {
    const fixture=JSON.parse(await readFile(join(artifacts,path),'utf8')); await provider.send('anvil_setCode',[address,fixture.deployedBytecode]);
  }
  const owner=HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').connect(provider);
  const artifact=JSON.parse(await readFile(new URL('../test/fixtures/TestToken.json',import.meta.url),'utf8'));
  const token=await new ContractFactory(artifact.abi,artifact.bytecode,owner).deploy(owner.address);
  console.log(JSON.stringify({rpc:'http://127.0.0.1:18545',dapp:'http://127.0.0.1:18777',owner:owner.address,token:await token.getAddress()}));
  const server=createServer(async(_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(await readFile(new URL('../test/fixtures/dapp.html',import.meta.url),'utf8'));});
  server.listen(18777,'127.0.0.1');
  const stop=()=>{server.close(); provider.destroy();child.kill('SIGTERM');};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}catch(e){provider.destroy();child.kill('SIGTERM');throw e;}
