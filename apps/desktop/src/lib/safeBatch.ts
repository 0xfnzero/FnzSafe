import {isValidEvmAddress} from "./evmAbi.ts";

export interface SafeBatchCall {to: string; value: string; data: string}
export const SAFE_MULTISEND_CALL_ONLY = "0x9641d764fc13c8b624c04430c7356c1c7c8102e2";
const word = (value: bigint) => value.toString(16).padStart(64, "0");

/** Canonical Safe 1.4.1 MultiSendCallOnly. Each packed inner operation is CALL.
 * The backend independently re-encodes this list and verifies the deployed runtime.
 */
export function safeBatchPayload(calls: SafeBatchCall[]): {to: string; value: string; data: string; batch: SafeBatchCall[]} {
  if (!Array.isArray(calls) || calls.length < 2 || calls.length > 100) throw Error("invalidTransactionFile");
  let packed = "";
  for (const call of calls) {
    if (!call || typeof call !== "object" || Object.keys(call).some(k=>!["to","value","data"].includes(k)) ||
      typeof call.to !== "string" || !isValidEvmAddress(call.to) || /^0x0{40}$/i.test(call.to) ||
      typeof call.value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(call.value) || BigInt(call.value) >= BigInt(2)**BigInt(256) ||
      typeof call.data !== "string" || call.data.length > 131074 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data)) throw Error("invalidTransactionFile");
    packed += "00" + call.to.slice(2).toLowerCase() + word(BigInt(call.value)) + word(BigInt((call.data.length-2)/2)) + call.data.slice(2).toLowerCase();
    if (packed.length/2 > 65536-100) throw Error("fileTooLarge");
  }
  return {to:SAFE_MULTISEND_CALL_ONLY, value:"0", data:"0x8d80ff0a" + word(BigInt(32)) + word(BigInt(packed.length/2)) + packed.padEnd(Math.ceil(packed.length/64)*64,"0"), batch:calls};
}

export function validateSafeBatch(p: {to: string; value: string; data: string; batch?: SafeBatchCall[]}): void {
  if (p.batch === undefined) return;
  const encoded = safeBatchPayload(p.batch);
  if (p.to.toLowerCase() !== encoded.to || p.value !== encoded.value || p.data.toLowerCase() !== encoded.data) throw Error("invalidTransactionFile");
}
