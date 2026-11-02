import assert from "node:assert/strict";
import test from "node:test";
import { functionSignature, type AbiFunctionItem, type AbiParam } from "./evmAbi.ts";
import {
  buildSafeAbiCall, initialSafeAbiValue, resolveSafeAbiDraft, safeAbiArgumentError,
  safeAbiFunctions, supportsSafeAbiForm, verifiedSafeCall,
} from "./safeAbi.ts";
const fn: AbiFunctionItem = { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] };
const target = "0x" + "12".repeat(20);
const word = (n: bigint) => n.toString(16).padStart(64, "0");

test("Safe ABI transfer matches the ERC20 selector and exact uint256 words", () => {
  const amount = "90071992547409931234567890";
  assert.equal(buildSafeAbiCall(fn, [target, amount]), "0xa9059cbb" + "0".repeat(24) + target.slice(2) + word(BigInt(amount)));
  assert.equal(safeAbiArgumentError(fn.inputs[1], "1.5"), "abiInvalidInteger");
  assert.equal(safeAbiArgumentError(fn.inputs[1], (BigInt(2) ** BigInt(256)).toString()), "abiInvalidInteger");
  assert.equal(safeAbiArgumentError(fn.inputs[0], "0x1234"), "abiInvalidAddress");
});
test("supports artifact imports and selects overloaded methods by canonical signature", () => {
  const overload = { ...fn, inputs: [{ name: "to", type: "address" }] };
  const text = JSON.stringify({ abi: [fn, overload, { ...fn, name: "balanceOf", stateMutability: "view" }] });
  assert.equal(safeAbiFunctions(text).length, 2);
  const draft = { text, signature: "transfer(address)", fileName: "artifact.json", args: [target] };
  assert.equal(resolveSafeAbiDraft(draft).data?.length, 74);
  assert.equal(resolveSafeAbiDraft({ ...draft, signature: "transfer(address,uint256)" }).error, "abiInvalidArgument");
  assert.equal(resolveSafeAbiDraft({ ...draft, text: "invalid" }).data, undefined);
  assert.equal(resolveSafeAbiDraft({ ...draft, text: JSON.stringify([fn]) }).error, "abiChooseMethod");
  assert.throws(() => safeAbiFunctions(JSON.stringify([fn, fn])), /abiDuplicateMethod/);
  assert.throws(() => safeAbiFunctions(JSON.stringify([{ ...fn, stateMutability: "pure" }])), /abiNoWriteMethods/);
});
test("unnamed and duplicate inputs remain positional, uint aliases use canonical selectors", () => {
  const unnamed = { ...fn, name: "set", inputs: [{ name: "", type: "uint" }, { name: "", type: "int" }] };
  assert.equal(functionSignature(unnamed), "set(uint256,int256)");
  assert.equal(buildSafeAbiCall(unnamed, ["1", "-2"]).slice(10), word(BigInt(1)) + word((BigInt(1) << BigInt(256)) - BigInt(2)));
  const duplicate = { ...unnamed, inputs: unnamed.inputs.map(p => ({ ...p, name: "value" })) };
  assert.equal(buildSafeAbiCall(duplicate, ["1", "-2"]), buildSafeAbiCall(unnamed, ["1", "-2"]));
  assert.equal(functionSignature({ ...fn, inputs: [{ name: "x", type: "uint[]" }] }), "transfer(uint256[])");
});
test("tuple and array forms encode positional nested values with correct dynamic offsets", () => {
  const tuple = { name: "config", type: "tuple", components: [{ name: "", type: "uint256" }, { name: "", type: "bool" }] };
  const method = { ...fn, name: "configure", inputs: [tuple, { name: "ids", type: "uint256[]" }] };
  assert.deepEqual(initialSafeAbiValue(tuple), ["", ""]);
  assert.equal(buildSafeAbiCall(method, [["7", "true"], ["9", "10"]]).slice(10), [BigInt(7), BigInt(1), BigInt(96), BigInt(2), BigInt(9), BigInt(10)].map(word).join(""));
  assert.equal(safeAbiArgumentError(tuple, ["7", ""]), "abiRequired");
  assert.equal(safeAbiArgumentError({ name: "ids", type: "uint256[2]" }, ["1"]), "abiInvalidArray");
  assert.equal(supportsSafeAbiForm({ name: "large", type: "uint256[64][64]" }), false);
  assert.equal(supportsSafeAbiForm({ name: "large", type: "uint256[99999999]" }), false);
});
test("bytes are explicit hex and read methods cannot create Safe calls", () => {
  assert.equal(safeAbiArgumentError({ name: "data", type: "bytes" }, "hello"), "abiInvalidBytes");
  assert.equal(safeAbiArgumentError({ name: "data", type: "bytes" }, "0xa"), "abiInvalidBytes");
  assert.equal(safeAbiArgumentError({ name: "data", type: "bytes2" }, "0xab"), "abiInvalidBytes");
  assert.equal(safeAbiArgumentError({ name: "data", type: "bytes" }, "0x"), null);
  assert.throws(() => buildSafeAbiCall({ ...fn, stateMutability: "view" }, [target, "1"]));
});
test("signing summaries require exact calldata and valid payable value", () => {
  const call = { fn, args: [target, "1"] };
  const proposal = { data: buildSafeAbiCall(fn, call.args), value: "0" };
  assert.ok(verifiedSafeCall(call, proposal));
  assert.equal(verifiedSafeCall({ ...call, args: [target, "2"] }, proposal), undefined);
  assert.equal(verifiedSafeCall(call, { ...proposal, data: proposal.data + "00" }), undefined);
  assert.equal(verifiedSafeCall(call, { ...proposal, value: "1" }), undefined);
  assert.ok(verifiedSafeCall({ ...call, fn: { ...fn, stateMutability: "payable" } }, { ...proposal, value: "1" }));
  assert.equal(verifiedSafeCall({ fn, args: [target, 1] }, proposal), undefined);
  assert.equal(verifiedSafeCall({ fn: null }, proposal), undefined);
});

test("malformed ABI definitions never silently drop parameters or change signatures", () => {
  for (const broken of [
    { ...fn, inputs: {} }, { ...fn, inputs: undefined }, { ...fn, inputs: [null] },
    { ...fn, inputs: [{ name: "x" }] }, { ...fn, outputs: {} },
    { ...fn, stateMutability: "payble" }, { ...fn, payable: "false" },
    { ...fn, name: "f(uint256)" },
    { ...fn, inputs: [{ name: "tuple", type: "tuple", components: [{ name: "a", type: "address" }, { name: "b" }] }] },
    { ...fn, inputs: [{ name: "tuple", type: "tuple[]", components: [null, { name: "x", type: "uint256" }] }] },
    { ...fn, inputs: [{ name: "x", type: "uint256[0]" }] },
    { ...fn, inputs: [{ name: "x", type: "uint256", components: [{ name: "y", type: "bool" }] }] },
  ]) assert.throws(() => safeAbiFunctions(JSON.stringify([broken])), JSON.stringify(broken));
});
test("mixed-case address typos are rejected in nested ABI parameters", () => {
  const correct = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const wrong = "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  assert.equal(safeAbiArgumentError(fn.inputs[0], correct), null);
  assert.equal(safeAbiArgumentError(fn.inputs[0], correct.toLowerCase()), null);
  assert.equal(safeAbiArgumentError(fn.inputs[0], wrong), "abiInvalidAddress");
  const tuple = { name: "owners", type: "tuple[]", components: [{ name: "owner", type: "address" }] };
  assert.throws(() => buildSafeAbiCall({ ...fn, inputs: [tuple] }, [[[wrong]]]));
});
test("rejects unpaired Unicode surrogates instead of silently replacing contract string data", () => {
  const p = { name: "memo", type: "string" };
  for (const value of ["\ud800", "x\udfff", "\ud800x"]) assert.equal(safeAbiArgumentError(p, value), "abiInvalidUnicode");
  for (const value of ["", "🙂", "\u0000", " a\n b "]) assert.equal(safeAbiArgumentError(p, value), null);
});
test("ABI input limits bound recursion, UTF-8 size and calldata size", () => {
  let p: AbiParam = { name: "x", type: "uint256" };
  for (let i = 0; i < 34; i++) p = { name: "x", type: "tuple", components: [p] };
  assert.throws(() => safeAbiFunctions(JSON.stringify([{ ...fn, inputs: [p] }])));
  assert.throws(() => safeAbiFunctions(JSON.stringify({ abi: [fn], extra: "汉".repeat(700000) })), /abiTooLarge/);
  assert.throws(() => buildSafeAbiCall({ ...fn, inputs: [{ name: "blob", type: "bytes" }] }, ["0x" + "ff".repeat(65536)]), /invalidCalldata/);
});

test("calldata size boundary and noncanonical integer types fail closed", () => {
  const bytes = { ...fn, inputs: [{ name: "blob", type: "bytes" }] };
  assert.equal((buildSafeAbiCall(bytes, ["0x" + "ab".repeat(65440)]).length - 2) / 2, 65508);
  assert.throws(() => buildSafeAbiCall(bytes, ["0x" + "ab".repeat(65441)]), /invalidCalldata/);
  for (const type of ["uint08", "int0256", "uint7", "uint264", "bytes0", "bytes33"])
    assert.equal(supportsSafeAbiForm({ name: "bad", type }), false);
});
