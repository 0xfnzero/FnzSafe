import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFunctionResult,
  encodeFunctionCalldata,
  formatUintToDecimalAmount,
  functionSignature,
  isReadableAbiFunction,
  keccak256,
  parseAbiJson,
  parseDecimalAmountToUint,
  type AbiFunctionItem,
} from "./evmAbi.ts";

const SAMPLE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "event", name: "Transfer", inputs: [] },
];

test("parses ABI functions and marks view methods as readable", () => {
  const abi = parseAbiJson(JSON.stringify(SAMPLE_ABI));

  assert.equal(abi.length, 2);
  assert.equal(abi[0].name, "balanceOf");
  assert.equal(isReadableAbiFunction(abi[0]), true);
  assert.equal(isReadableAbiFunction(abi[1]), false);
  assert.equal(functionSignature(abi[1]), "transfer(address,uint256)");
});

test("parses Foundry/Hardhat artifact objects that wrap abi", () => {
  const abi = parseAbiJson(
    JSON.stringify({
      abi: SAMPLE_ABI,
      bytecode: { object: "0x" },
      deployedBytecode: { object: "0x" },
    }),
  );
  assert.equal(abi.length, 2);
  assert.equal(abi[0].name, "balanceOf");
  assert.equal(abi[1].name, "transfer");
});

test("parses nested artifact wrappers that expose abi", () => {
  const abi = parseAbiJson(JSON.stringify({ data: { abi: SAMPLE_ABI } }));
  assert.equal(abi.length, 2);
  assert.equal(abi[1].name, "transfer");
});

test("keccak256 matches Ethereum transfer selector", () => {
  const digest = keccak256(new TextEncoder().encode("transfer(address,uint256)"));
  const selector = Array.from(digest.subarray(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(selector, "a9059cbb");
});

test("encodes ERC-20 transfer calldata", () => {
  const fn: AbiFunctionItem = {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  };

  const encoded = encodeFunctionCalldata(fn, {
    to: "0x1111111111111111111111111111111111111111",
    amount: "1000",
  });

  assert.equal(encoded.selector, "0xa9059cbb");
  assert.equal(
    encoded.data,
    "0xa9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000003e8",
  );
});

test("decodes uint256 return data", () => {
  const fn: AbiFunctionItem = {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  };
  const values = decodeFunctionResult(
    fn,
    "0x00000000000000000000000000000000000000000000000000000000000003e8",
  );
  assert.deepEqual(values, ["1000"]);
});

test("encodes string arguments with dynamic ABI layout", () => {
  const fn: AbiFunctionItem = {
    type: "function",
    name: "setName",
    stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "string" }],
    outputs: [],
  };
  const encoded = encodeFunctionCalldata(fn, { name: "Fnz" });
  assert.equal(encoded.selector, "0xc47f0027");
  assert.match(encoded.data, /^0xc47f0027[0-9a-f]+$/i);
  assert.ok(encoded.data.includes("0000000000000000000000000000000000000000000000000000000000000020"));
  assert.ok(encoded.data.includes("0000000000000000000000000000000000000000000000000000000000000003"));
});

test("converts decimal amounts with decimals to uint base units", () => {
  assert.equal(parseDecimalAmountToUint("1", 6), "1000000");
  assert.equal(parseDecimalAmountToUint("1.5", 6), "1500000");
  assert.equal(parseDecimalAmountToUint("0.000001", 6), "1");
  assert.equal(parseDecimalAmountToUint("1.0", 18), "1000000000000000000");
  assert.equal(formatUintToDecimalAmount("1500000", 6), "1.5");
  assert.equal(formatUintToDecimalAmount("1000000", 6), "1");
  assert.equal(formatUintToDecimalAmount("1", 6), "0.000001");
});
