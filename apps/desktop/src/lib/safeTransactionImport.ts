import {isValidEvmAddress, parseAbiJson} from "./evmAbi.ts";
import {buildSafeAbiCall, MAX_ARRAY_ITEMS, type SafeAbiValue} from "./safeAbi.ts";
import {parseSafeProposal, type SafeProposal} from "./safeMultisig.ts";

export const MAX_SAFE_IMPORT_BYTES = 400_000;
export interface SafeImportedTransaction { to: string; value: string; data: string }
export interface SafeTransactionFile {
  kind: "transactions"; chainId: number; safeAddress?: string; transactions: SafeImportedTransaction[];
}
export type SafeImport = SafeTransactionFile | {kind: "proposal"; proposal: SafeProposal};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidTransactionFile");
  return value as Record<string, unknown>;
}
function address(value: unknown): string {
  if (typeof value !== "string" || !isValidEvmAddress(value) || /^0x0{40}$/i.test(value)) throw new Error("invalidRecipient");
  return value;
}
function abiValue(value: unknown,depth=0): SafeAbiValue {
  if(depth>32)throw new Error("invalidImportMethod");
  if(Array.isArray(value)) {
    if(value.length>MAX_ARRAY_ITEMS)throw new Error("invalidImportMethod");
    return value.map(item=>abiValue(item,depth+1));
  }
  if(typeof value==="string"||typeof value==="boolean"||(typeof value==="number"&&Number.isSafeInteger(value)))return String(value);
  throw new Error("invalidImportMethod");
}
function calldata(tx: Record<string, unknown>): string {
  // Encoded bytes are authoritative. Do not replace them with unverified ABI labels.
  if (typeof tx.data === "string") return tx.data;
  if (tx.data !== undefined && tx.data !== null) throw new Error("invalidCalldata");
  if (!tx.contractMethod) {
    if (tx.contractInputsValues != null) throw new Error("invalidTransactionFile");
    return "0x";
  }
  try {
    const method = object(tx.contractMethod);
    const [fn] = parseAbiJson(JSON.stringify([{...method, type: "function"}]));
    if (fn.inputs.length > 64 || fn.stateMutability === "view" || fn.stateMutability === "pure") throw new Error();
    const values = tx.contractInputsValues == null && !fn.inputs.length ? {} : object(tx.contractInputsValues);
    if (Object.keys(values).length !== fn.inputs.length || new Set(fn.inputs.map(input => input.name)).size !== fn.inputs.length) throw new Error();
    const args = fn.inputs.map(input => {
      if (!Object.hasOwn(values, input.name) || typeof values[input.name] !== "string") throw new Error();
      // Safe Transaction Builder stores arrays and tuples as JSON strings.
      return /\[|^tuple/.test(input.type) ? abiValue(JSON.parse(values[input.name] as string, (_key,value: unknown) => {
        if(typeof value==="number"&&!Number.isSafeInteger(value))throw new Error();
        return value;
      })) : values[input.name] as string;
    });
    if (fn.stateMutability !== "payable" && tx.value !== "0") throw new Error();
    return buildSafeAbiCall(fn, args);
  } catch { throw new Error("invalidImportMethod"); }
}

/** Parse unsigned Transaction Builder files separately from signed FnzSafe exchanges. */
export function parseSafeImport(raw: string): SafeImport {
  if (new TextEncoder().encode(raw).length > MAX_SAFE_IMPORT_BYTES) throw new Error("fileTooLarge");
  let file: Record<string, unknown>;
  try { file = object(JSON.parse(raw)); } catch { throw new Error("invalidTransactionFile"); }
  if (file.version === 1) {
    try { return {kind: "proposal", proposal: parseSafeProposal(raw)}; }
    catch { throw new Error("invalidImport"); }
  }
  if (file.version !== "1.0") throw new Error("invalidTransactionFile");
  if (typeof file.chainId !== "string" || !/^[1-9]\d*$/.test(file.chainId) || !Number.isSafeInteger(Number(file.chainId))) throw new Error("invalidTransactionFile");
  if (!Array.isArray(file.transactions) || !file.transactions.length || file.transactions.length > 100) throw new Error("invalidTransactionFile");
  const meta = file.meta == null ? {} : object(file.meta);
  const safeAddress = meta.createdFromSafeAddress == null || meta.createdFromSafeAddress === "" ? undefined : address(meta.createdFromSafeAddress);
  const transactions = file.transactions.map(item => {
    const tx = object(item);
    if (Object.keys(tx).some(key => !["to", "value", "data", "contractMethod", "contractInputsValues", "operation"].includes(key)) ||
      (tx.operation !== undefined && tx.operation !== 0)) throw new Error("unsupportedImportOperation");
    const to = address(tx.to);
    if (typeof tx.value !== "string" || tx.value.length > 78 || !/^(0|[1-9]\d*)$/.test(tx.value) || BigInt(tx.value) >= (BigInt(1) << BigInt(256))) throw new Error("invalidAmount");
    const data = calldata(tx);
    if (data.length > 131074 || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new Error("invalidCalldata");
    return {to, value: tx.value, data};
  });
  return {kind: "transactions", chainId: Number(file.chainId), safeAddress, transactions};
}

/** Never silently switch networks or substitute the Safe named in a file. */
export function safeImportTarget(file: SafeTransactionFile, chainId: number, selectedAddress: string): string {
  if (file.chainId !== chainId) throw new Error("wrongNetwork");
  const target = file.safeAddress || selectedAddress;
  if (!target) throw new Error("importSafeRequired");
  if (file.safeAddress && selectedAddress && file.safeAddress.toLowerCase() !== selectedAddress.toLowerCase()) throw new Error("wrongImportSafe");
  return address(target);
}
