import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes, webcrypto} from 'node:crypto';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the desktop API binary path');
await access(resolve(binary));
const fixture = await mkdtemp(join(tmpdir(), 'fnzsafe-rpc-settings-'));
const token = randomBytes(32).toString('hex');
let reportedChain = '0x539';
let requestCount = 0;
const rpc = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const message = JSON.parse(body);
  assert.equal(message.method, 'eth_chainId');
  requestCount++;
  response.writeHead(200, {'content-type':'application/json'});
  response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:reportedChain}));
});
const reserve = createServer();
await new Promise((done) => rpc.listen(0, '127.0.0.1', done));
await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
const apiPort = reserve.address().port;
await new Promise((done) => reserve.close(done));
const api = `http://127.0.0.1:${apiPort}`;
const child = spawn(resolve(binary), [], {
  env:{...process.env, HOST:'127.0.0.1', PORT:String(apiPort), FNZERO_SAFE_API_TOKEN:token, FNZERO_SAFE_DB_PATH:join(fixture,'wallets.db')},
  stdio:'ignore',
});
let startupError;
const stopped = new Promise((done) => {
  child.once('exit', done);
  child.once('error', (error) => { startupError = error; done(); });
});
try {
  let session;
  for (let i=0;i<200;i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error('API process exited before startup');
    try { session = await (await fetch(`${api}/api/secure/session`,{signal:AbortSignal.timeout(1000)})).json(); break; }
    catch { await new Promise((done) => setTimeout(done,100)); }
  }
  assert.ok(session?.public_key_pem, 'API session did not start');
  const publicKey = await webcrypto.subtle.importKey('spki', Buffer.from(session.public_key_pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,''),'base64'),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  async function validate(chain) {
    const key = await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
    const iv = randomBytes(12);
    const ciphertext = await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,Buffer.from(JSON.stringify(chain)));
    const encryptedKey = await webcrypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,await webcrypto.subtle.exportKey('raw',key));
    const response = await fetch(`${api}/api/evm/rpc/validate`,{method:'POST',headers:{'content-type':'application/json','x-fnzero-safe-token':token,'x-fnzero-safe-secure-body':'1',origin:api},body:JSON.stringify({version:1,encrypted_key:Buffer.from(encryptedKey).toString('base64'),iv:iv.toString('base64'),ciphertext:Buffer.from(ciphertext).toString('base64')})});
    return {status:response.status,body:await response.json()};
  }
  const chain = {chain_id:1337,name:'Local fixture',native_symbol:'ETH',rpc_url:`http://127.0.0.1:${rpc.address().port}/fixture-api-key`,explorer_url:null,testnet:true};
  assert.deepEqual(await validate(chain),{status:200,body:{valid:true}});
  reportedChain = '0x1';
  const wrong = await validate(chain);
  assert.notEqual(wrong.status,200);
  assert.equal(JSON.stringify(wrong).includes('fixture-api-key'),false);
  const rejected = await validate({...chain,rpc_url:'http://example.com/fixture-api-key'});
  assert.notEqual(rejected.status,200);
  assert.equal(JSON.stringify(rejected).includes('fixture-api-key'),false);
  assert.equal(requestCount,2,'Invalid URLs must be rejected before connecting');
  console.log('RPC settings integration passed: encrypted API, matching/mismatched chain, URL rejection, and redacted errors.');
} finally {
  child.kill('SIGTERM');
  await stopped;
  await new Promise((done) => rpc.close(done));
  await rm(fixture,{recursive:true,force:true});
}
