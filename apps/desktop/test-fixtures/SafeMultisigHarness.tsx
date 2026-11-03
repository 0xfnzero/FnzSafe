"use client";
// Development-only synthetic service: never connects to an RPC or signs a real transaction.
import { useEffect, useRef, useState } from "react";
import { SafeMultisigPanel, type SafeUiService } from "../src/components/SafeMultisigPanel";
import { SAFE_STORAGE_KEY, type SafeAccount, type SafeProposal } from "../src/lib/safeMultisig";
const ownerA = "0x1111111111111111111111111111111111111111";
const ownerB = "0x2222222222222222222222222222222222222222";
const outsider = "0x3333333333333333333333333333333333333333";
const safeA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const safeB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const safeC = "0xcccccccccccccccccccccccccccccccccccccccc";
const makeAccount = (address: string): SafeAccount => ({ address, chain_id: 97, version: "1.4.1", owners: [ownerA, ownerB], threshold: 2, nonce: "0", balance_wei: "1000000000000000000" });
const proposal = (nonce: string): SafeProposal => ({ version: 1, chain_id: 97, safe_address: safeA, to: outsider, value: "10000000000000000", data: "0x", nonce, safe_tx_hash: `0x${nonce === "0" ? "11".repeat(32) : "22".repeat(32)}`, signatures: [] });
export default function SafeMultisigHarness() {
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const fail = useRef(false);
  const substitute = useRef(false);
  const accounts = useRef<Record<string, SafeAccount>>({ [safeA]: makeAccount(safeA), [safeB]: makeAccount(safeB), [safeC]: makeAccount(safeC) });
  const receipts = useRef<Record<string, { address: string; proposal?: SafeProposal; done?: boolean }>>({});
  const serial = useRef(3);
  useEffect(() => {
    if (new URLSearchParams(location.search).has("empty")) localStorage.setItem(SAFE_STORAGE_KEY, JSON.stringify({safes:[],proposals:[]}));
    if (!localStorage.getItem(SAFE_STORAGE_KEY)) localStorage.setItem(SAFE_STORAGE_KEY, JSON.stringify({
      safes: [{ chainId: 97, address: safeA, label: "Treasury Alpha", owners: [ownerA, ownerB], createdBy: ownerA },
        { chainId: 97, address: safeB, label: "Operations Beta", owners: [ownerA, ownerB], createdBy: ownerA }],
      proposals: [{proposal: proposal("0")}, {proposal: proposal("1")}],
    }));
    setReady(true);
  }, []);
  const service: SafeUiService = async ({chain, command: c, walletAddress, approved}) => {
    if (c.kind === "discover") {
      await new Promise(resolve => setTimeout(resolve, 900));
      if (fail.current) { fail.current=false; throw new Error("Simulated discovery RPC failure"); }
      const matches = chain.chain_id === 97 && [ownerA,ownerB].includes(walletAddress) ? [makeAccount(safeA),makeAccount(safeB)] : [];
      return {discovery:{accounts:matches,from_block:0,to_block:100,latest_block:100,next_before_block:null,next_offset:0,block_span:50000,complete:true,unsupported:0}};
    }
    await new Promise(resolve => setTimeout(resolve, 180));
    if (fail.current) { fail.current = false; throw new Error("Simulated RPC unavailable. Retry the read."); }
    const info = (address: string) => {
      const account = accounts.current[address.toLowerCase()];
      if (!account) throw new Error("Unknown test Safe");
      return {...account, chain_id: chain.chain_id};
    };
    if (c.kind === "account") return { account: info(c.address as string) };
    if (c.kind === "prepare_create") return { address: safeC, gas_limit: "250000", estimated_fee_wei: "250000000000000" };
    if (c.kind === "create") {
      if (!approved) throw new Error("Missing approval");
      const hash = `0x${(++serial.current).toString(16).padStart(64,"0")}`;
      accounts.current[safeC] = {...makeAccount(safeC), owners: c.owners as string[], threshold: c.threshold as number};
      receipts.current[hash] = {address:safeC};
      return {address:safeC,transaction_hash:hash,status:"submitted"};
    }
    if (c.kind === "propose") {
      const data = substitute.current ? "0xdeadbeef" : c.data as string;
      substitute.current = false;
      return {account:info(c.address as string), proposal:{...proposal(c.nonce as string),
        safe_address:c.address as string, chain_id:chain.chain_id, to:c.to as string, value:c.value as string, data, batch:c.batch as SafeProposal["batch"],
        safe_tx_hash:`0x${(++serial.current).toString(16).padStart(64,"0")}`}};
    }
    if (c.kind === "receipt") {
      const receipt = receipts.current[c.transaction_hash as string];
      if (!receipt) return {status:"pending"};
      if (receipt.proposal && !receipt.done) { accounts.current[receipt.address].nonce = (BigInt(receipt.proposal.nonce)+BigInt(1)).toString(); receipt.done=true; }
      return {status:"confirmed", account:info(receipt.address)};
    }
    const p = c.proposal as SafeProposal;
    const account = info(p.safe_address);
    if (BigInt(p.nonce) < BigInt(account.nonce)) throw new Error("Nonce already consumed");
    if (c.kind === "validate") return {proposal:p,account};
    if (c.kind === "sign") {
      if (!approved) throw new Error("Missing approval");
      return {proposal:{...p,signatures:[...p.signatures,{owner:walletAddress,signature:`0x${"44".repeat(64)}1b`}]},account};
    }
    if (c.kind === "prepare_execute") return {proposal:p,account,gas_limit:"50000",estimated_fee_wei:"50000000000000"};
    if (c.kind === "execute") {
      if (!approved) throw new Error("Missing approval");
      const hash=`0x${(++serial.current).toString(16).padStart(64,"0")}`;
      receipts.current[hash]={address:p.safe_address,proposal:p};
      return {transaction_hash:hash,status:"submitted"};
    }
    throw new Error("Unknown synthetic command");
  };
  return <main className="mx-auto max-w-5xl p-5"><h1 style={{ position: "sticky", top: 0, zIndex: 20, background: "#fef3c7", color: "#451a03", border: "1px solid #f59e0b", padding: 12, borderRadius: 12, fontWeight: 700 }}>UI TEST · 模拟数据，不连接区块链 · No blockchain transactions</h1>
    <div className="my-4 flex gap-3"><button onClick={() => {fail.current=true;}}>Fail next request</button><button onClick={() => {substitute.current=true;}}>Substitute next proposal response</button><button onClick={() => {localStorage.removeItem(SAFE_STORAGE_KEY);setReady(false);setVersion(v=>v+1);location.reload();}}>Reset fixture</button></div>
    {ready && <SafeMultisigPanel key={version} service={service} initialChainId={97} initialWalletId="a" wallets={[
      {id:"a",name:"Signer A",evm_address:ownerA},{id:"b",name:"Signer B",evm_address:ownerB},{id:"c",name:"Executor C",evm_address:outsider}
    ]} chains={[
      {chain_id:97,name:"BNB Testnet",native_symbol:"tBNB",testnet:true,rpc_url:"http://127.0.0.1:39999"},
      {chain_id:56,name:"BNB Mainnet",native_symbol:"BNB",testnet:false,rpc_url:"http://127.0.0.1:39999"}
    ]} />}
  </main>;
}
