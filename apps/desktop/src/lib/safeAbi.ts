import {
  encodeFunctionCalldataValues, functionSignature, isReadableAbiFunction,
  isUnsupportedAbiType, parseAbiJson, type AbiFunctionItem, type AbiParam,
} from "./evmAbi.ts";

export type SafeAbiValue = string | SafeAbiValue[];
export type SafeCallMetadata = { fn: AbiFunctionItem; args: SafeAbiValue[] };
export type SafeAbiDraft = { text: string; fileName: string; signature: string; args: SafeAbiValue[] };
export const emptySafeAbiDraft = (): SafeAbiDraft => ({ text: "", fileName: "", signature: "", args: [] });
export const MAX_ABI_BYTES = 2_000_000;
export const MAX_ARRAY_ITEMS = 64;

export function arrayItem(param: AbiParam): { param: AbiParam; length?: number } | undefined {
  const match = param.type.match(/^(.*)\[(\d*)\]$/);
  return match ? { param: { ...param, type: match[1] }, length: match[2] ? Number(match[2]) : undefined } : undefined;
}
function formSize(param: AbiParam, depth = 0): number {
  if (depth > 8 || isUnsupportedAbiType(param)) return Infinity;
  const item = arrayItem(param);
  if (item) {
    if (item.length !== undefined && (item.length < 1 || item.length > MAX_ARRAY_ITEMS)) return Infinity;
    return 1 + (item.length ?? 1) * formSize(item.param, depth + 1);
  }
  if (param.type !== "tuple") return 1;
  if (!param.components?.length || param.components.length > 64) return Infinity;
  return 1 + param.components.reduce((size, child) => size + formSize(child, depth + 1), 0);
}
export function supportsSafeAbiForm(param: AbiParam): boolean {
  return formSize(param) <= 256;
}
export function initialSafeAbiValue(param: AbiParam): SafeAbiValue {
  if (!supportsSafeAbiForm(param)) return "";
  const item = arrayItem(param);
  if (item) return Array.from({ length: item.length || 0 }, () => initialSafeAbiValue(item.param));
  if (param.type === "tuple") return param.components!.map(initialSafeAbiValue);
  return param.type === "bytes" ? "0x" : "";
}
export function safeAbiFunctions(text: string): AbiFunctionItem[] {
  if (text.length > MAX_ABI_BYTES || new TextEncoder().encode(text).length > MAX_ABI_BYTES) throw new Error("abiTooLarge");
  const functions = parseAbiJson(text).filter(fn => !isReadableAbiFunction(fn));
  if (!functions.length) throw new Error("abiNoWriteMethods");
  const signatures = functions.map(functionSignature);
  if (new Set(signatures).size !== signatures.length) throw new Error("abiDuplicateMethod");
  return functions;
}
function validateValue(param: AbiParam, value: SafeAbiValue): void {
  const item = arrayItem(param);
  if (item) {
    if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || (item.length !== undefined && value.length !== item.length)) throw new Error("abiInvalidArray");
    value.forEach(v => validateValue(item.param, v));
  } else if (param.type === "tuple") {
    if (!Array.isArray(value) || value.length !== param.components!.length) throw new Error("abiInvalidArray");
    value.forEach((v, index) => validateValue(param.components![index], v));
  } else {
    if (typeof value !== "string") throw new Error("abiInvalidArgument");
    if (param.type.startsWith("bytes") && !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error("abiInvalidBytes");
    if (param.type === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("abiInvalidUnicode");
    if (param.type !== "string" && !value.trim()) throw new Error("abiRequired");
  }
}
export function safeAbiArgumentError(param: AbiParam, value: SafeAbiValue): string | null {
  try {
    if (!supportsSafeAbiForm(param)) return "abiUnsupported";
    validateValue(param, value);
    encodeFunctionCalldataValues({ type: "function", name: "check", inputs: [param], outputs: [], stateMutability: "nonpayable" }, [value]);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message.startsWith("abi")) return message;
    if (param.type === "address") return "abiInvalidAddress";
    if (/^u?int/.test(param.type)) return "abiInvalidInteger";
    if (param.type.startsWith("bytes")) return "abiInvalidBytes";
    return "abiInvalidArgument";
  }
}
export function buildSafeAbiCall(fn: AbiFunctionItem, args: SafeAbiValue[]): string {
  if (isReadableAbiFunction(fn) || fn.inputs.length !== args.length || fn.inputs.length > 64) throw new Error("abiInvalidArgument");
  fn.inputs.forEach((param, index) => {
    const error = safeAbiArgumentError(param, args[index]);
    if (error) throw new Error(error);
  });
  const { data } = encodeFunctionCalldataValues(fn, args);
  if (data.length > 131074) throw new Error("invalidCalldata");
  return data;
}
export function resolveSafeAbiDraft(draft: SafeAbiDraft): { fn?: AbiFunctionItem; data?: string; error?: string; metadata?: SafeCallMetadata } {
  let fn: AbiFunctionItem | undefined;
  try {
    if (!draft.text) return { error: "abiChooseFile" };
    fn = safeAbiFunctions(draft.text).find(fn => functionSignature(fn) === draft.signature);
    if (!fn) return { error: "abiChooseMethod" };
    const data = buildSafeAbiCall(fn, draft.args);
    return { fn, data, metadata: { fn, args: draft.args } };
  } catch (e) { return { fn, error: abiErrorKey(e) }; }
}
export function abiErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(abi[A-Z]\w*|invalidCalldata)$/.test(message) ? message : "abiInvalidFile";
}
/** Local display hints are shown only if re-encoding reproduces every calldata byte. */
export function verifiedSafeCall(metadata: unknown, proposal: { data: string; value: string }): SafeCallMetadata | undefined {
  try {
    if (!metadata || typeof metadata !== "object") return;
    const candidate = metadata as SafeCallMetadata;
    const fn = parseAbiJson(JSON.stringify([candidate.fn]))[0];
    if (fn.stateMutability !== "payable" && BigInt(proposal.value) !== BigInt(0)) return;
    if (buildSafeAbiCall(fn, candidate.args).toLowerCase() === proposal.data.toLowerCase()) return { fn, args: candidate.args };
  } catch { /* Untrusted or stale metadata must never replace raw transaction details. */ }
}
