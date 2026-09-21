/**
 * Minimal ABI JSON helpers for EVM contract function calls.
 * Supports common Solidity types used by most token / DeFi contracts.
 */

import { keccak_256 } from "@noble/hashes/sha3";

export type AbiStateMutability = "pure" | "view" | "nonpayable" | "payable";

export interface AbiParam {
  name: string;
  type: string;
  components?: AbiParam[];
}

export interface AbiFunctionItem {
  type: "function";
  name: string;
  inputs: AbiParam[];
  outputs: AbiParam[];
  stateMutability: AbiStateMutability;
}

export interface EncodedAbiCall {
  signature: string;
  selector: string;
  data: string;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function requireCleanName(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeMutability(value: unknown, payable?: unknown, constant?: unknown): AbiStateMutability {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "pure" || raw === "view" || raw === "nonpayable" || raw === "payable") return raw;
  if (payable === true) return "payable";
  if (constant === true) return "view";
  return "nonpayable";
}

function parseParam(value: unknown, index: number): AbiParam | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = requireCleanName(record.type);
  if (!type) return null;
  const name = requireCleanName(record.name, `arg${index}`);
  const components = Array.isArray(record.components)
    ? record.components
        .map((item, childIndex) => parseParam(item, childIndex))
        .filter((item): item is AbiParam => Boolean(item))
    : undefined;
  if (type.startsWith("tuple") && (!components || components.length === 0)) {
    return null;
  }
  return { name, type, components };
}

/**
 * Normalize common ABI JSON shapes into a flat ABI item array.
 * Accepts:
 * - raw ABI array: `[{ type: "function", ... }, ...]`
 * - Foundry / Hardhat / solc artifact: `{ abi: [...] }`
 * - nested wrappers that still expose an `abi` array (e.g. `{ data: { abi } }`)
 */
export function extractAbiArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") {
    throw new Error("invalid-abi");
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.abi)) return record.abi;
  // Soft unwrap one nesting level used by some exporters / clipboard wrappers.
  for (const key of ["result", "data", "contract", "output"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRecord = nested as Record<string, unknown>;
      if (Array.isArray(nestedRecord.abi)) return nestedRecord.abi;
    }
  }
  throw new Error("invalid-abi");
}

export function parseAbiJson(value: string): AbiFunctionItem[] {
  const parsed = JSON.parse(value) as unknown;
  const items = extractAbiArray(parsed);
  const functions: AbiFunctionItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (String(record.type || "").toLowerCase() !== "function") continue;
    const name = requireCleanName(record.name);
    if (!name) continue;
    const inputs = Array.isArray(record.inputs)
      ? record.inputs
          .map((input, index) => parseParam(input, index))
          .filter((input): input is AbiParam => Boolean(input))
      : [];
    if (Array.isArray(record.inputs) && inputs.length !== record.inputs.length) {
      continue;
    }
    const outputs = Array.isArray(record.outputs)
      ? record.outputs
          .map((output, index) => parseParam(output, index))
          .filter((output): output is AbiParam => Boolean(output))
      : [];
    functions.push({
      type: "function",
      name,
      inputs,
      outputs,
      stateMutability: normalizeMutability(record.stateMutability, record.payable, record.constant),
    });
  }
  if (functions.length === 0) {
    throw new Error("invalid-abi-empty");
  }
  return functions;
}

export function isReadableAbiFunction(fn: AbiFunctionItem): boolean {
  return fn.stateMutability === "view" || fn.stateMutability === "pure";
}

export function isPayableAbiFunction(fn: AbiFunctionItem): boolean {
  return fn.stateMutability === "payable";
}

export function abiTypeLabel(param: AbiParam): string {
  if (param.type === "tuple" && param.components?.length) {
    return `tuple(${param.components.map((item) => abiTypeLabel(item)).join(",")})`;
  }
  if (param.type.startsWith("tuple[") && param.components?.length) {
    const suffix = param.type.slice("tuple".length);
    return `tuple(${param.components.map((item) => abiTypeLabel(item)).join(",")})${suffix}`;
  }
  return param.type;
}

export function canonicalAbiType(param: AbiParam): string {
  if (param.type === "tuple") {
    if (!param.components?.length) throw new Error(`unsupported-abi-type:${param.type}`);
    return `(${param.components.map((item) => canonicalAbiType(item)).join(",")})`;
  }
  if (param.type.startsWith("tuple[")) {
    if (!param.components?.length) throw new Error(`unsupported-abi-type:${param.type}`);
    const suffix = param.type.slice("tuple".length);
    return `(${param.components.map((item) => canonicalAbiType(item)).join(",")})${suffix}`;
  }
  return param.type;
}

export function functionSignature(fn: AbiFunctionItem): string {
  return `${fn.name}(${fn.inputs.map((input) => canonicalAbiType(input)).join(",")})`;
}

export function isUnsupportedAbiType(param: AbiParam): boolean {
  try {
    assertSupportedType(param);
    return false;
  } catch {
    return true;
  }
}

function assertSupportedType(param: AbiParam): void {
  const type = param.type;
  if (type === "tuple" || type.startsWith("tuple[")) {
    if (!param.components?.length) throw new Error(`unsupported-abi-type:${type}`);
    for (const component of param.components) assertSupportedType(component);
    return;
  }
  if (type.endsWith("[]")) {
    assertSupportedType({ name: param.name, type: type.slice(0, -2), components: param.components });
    return;
  }
  const fixedArray = type.match(/^(.*)\[(\d+)\]$/);
  if (fixedArray) {
    assertSupportedType({ name: param.name, type: fixedArray[1], components: param.components });
    return;
  }
  if (
    type === "address" ||
    type === "bool" ||
    type === "string" ||
    type === "bytes" ||
    /^bytes([1-9]|[12]\d|3[0-2])$/.test(type) ||
    /^u?int(\d+)?$/.test(type)
  ) {
    if (/^u?int(\d+)$/.test(type)) {
      const bits = Number(type.replace(/^u?int/, ""));
      if (!Number.isInteger(bits) || bits <= 0 || bits > 256 || bits % 8 !== 0) {
        throw new Error(`unsupported-abi-type:${type}`);
      }
    }
    return;
  }
  throw new Error(`unsupported-abi-type:${type}`);
}

function hexToBytes(hex: string): Uint8Array {
  let normalized = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new Error("invalid-hex");
  }
  if (normalized.length % 2 !== 0) normalized = `0${normalized}`;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pad32Left(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("value-too-large");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function pad32Right(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("value-too-large");
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

function encodeLength(length: number): Uint8Array {
  return pad32Left(hexToBytes(BigInt(length).toString(16)));
}

function isDynamicAbiType(param: AbiParam): boolean {
  if (param.type === "string" || param.type === "bytes" || param.type.endsWith("[]")) return true;
  if (param.type === "tuple") {
    return Boolean(param.components?.some((item) => isDynamicAbiType(item)));
  }
  const fixedArray = param.type.match(/^(.*)\[(\d+)\]$/);
  if (fixedArray) {
    return isDynamicAbiType({ name: param.name, type: fixedArray[1], components: param.components });
  }
  return false;
}

function parseIntegerBits(type: string, signed: boolean): number {
  const prefix = signed ? "int" : "uint";
  if (type === prefix) return 256;
  const bits = Number(type.slice(prefix.length));
  if (!Number.isInteger(bits) || bits <= 0 || bits > 256 || bits % 8 !== 0) {
    throw new Error(`unsupported-abi-type:${type}`);
  }
  return bits;
}

function encodeUint(value: string, bits: number): Uint8Array {
  const trimmed = value.trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) throw new Error("invalid-uint");
  const number = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? BigInt(trimmed)
    : BigInt(trimmed);
  if (number < BigInt(0)) throw new Error("invalid-uint");
  const max = (BigInt(1) << BigInt(bits)) - BigInt(1);
  if (number > max) throw new Error("uint-overflow");
  return pad32Left(hexToBytes(number.toString(16) || "0"));
}

function encodeInt(value: string, bits: number): Uint8Array {
  const trimmed = value.trim();
  if (!/^-?(0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) throw new Error("invalid-int");
  const number = trimmed.includes("0x") || trimmed.includes("0X")
    ? BigInt(trimmed)
    : BigInt(trimmed);
  const min = -(BigInt(1) << BigInt(bits - 1));
  const max = (BigInt(1) << BigInt(bits - 1)) - BigInt(1);
  if (number < min || number > max) throw new Error("int-overflow");
  let twos = number;
  if (twos < BigInt(0)) twos = (BigInt(1) << BigInt(256)) + twos;
  return pad32Left(hexToBytes(twos.toString(16) || "0"));
}

function encodeAddress(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed)) throw new Error("invalid-address");
  return pad32Left(hexToBytes(trimmed));
}

function encodeBool(value: string): Uint8Array {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1") return encodeUint("1", 8);
  if (trimmed === "false" || trimmed === "0") return encodeUint("0", 8);
  throw new Error("invalid-bool");
}

function encodeFixedBytes(type: string, value: string): Uint8Array {
  const size = Number(type.slice("bytes".length));
  const trimmed = value.trim();
  const bytes = HEX_RE.test(trimmed) ? hexToBytes(trimmed) : new TextEncoder().encode(trimmed);
  if (bytes.length !== size) throw new Error(`invalid-${type}`);
  return pad32Right(bytes);
}

function encodeDynamicBytes(value: string): Uint8Array {
  const trimmed = value.trim();
  const bytes = HEX_RE.test(trimmed)
    ? hexToBytes(trimmed)
    : new TextEncoder().encode(trimmed);
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  const body = new Uint8Array(paddedLength);
  body.set(bytes, 0);
  return concatBytes([encodeLength(bytes.length), body]);
}

function encodeString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  const body = new Uint8Array(paddedLength);
  body.set(bytes, 0);
  return concatBytes([encodeLength(bytes.length), body]);
}

function parseJsonArray(value: string): unknown[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid-array");
  return parsed;
}

function encodeTuple(components: AbiParam[], values: unknown): Uint8Array {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("invalid-tuple");
  }
  const record = values as Record<string, unknown>;
  const encodedValues = components.map((component, index) => {
    const raw = record[component.name] ?? record[String(index)] ?? record[`arg${index}`];
    return encodeAbiValue(component, raw);
  });
  return encodeAbiSequence(components, encodedValues);
}

type EncodedValue = { dynamic: boolean; head: Uint8Array; tail: Uint8Array };

function encodeAbiValue(param: AbiParam, raw: unknown): EncodedValue {
  assertSupportedType(param);
  if (param.type === "tuple") {
    const encoded = encodeTuple(param.components || [], raw);
    return isDynamicAbiType(param)
      ? { dynamic: true, head: new Uint8Array(32), tail: encoded }
      : { dynamic: false, head: encoded, tail: new Uint8Array() };
  }

  const fixedArray = param.type.match(/^(.*)\[(\d+)\]$/);
  if (fixedArray) {
    const itemType = fixedArray[1];
    const length = Number(fixedArray[2]);
    const items = Array.isArray(raw) ? raw : parseJsonArray(String(raw ?? ""));
    if (items.length !== length) throw new Error("invalid-array-length");
    const child = { name: param.name, type: itemType, components: param.components };
    const encodedItems = items.map((item) => encodeAbiValue(child, item));
    const packed = encodeAbiSequence(
      Array.from({ length }, () => child),
      encodedItems,
    );
    return isDynamicAbiType(child)
      ? { dynamic: true, head: new Uint8Array(32), tail: packed }
      : { dynamic: false, head: packed, tail: new Uint8Array() };
  }

  if (param.type.endsWith("[]")) {
    const child = {
      name: param.name,
      type: param.type.slice(0, -2),
      components: param.components,
    };
    const items = Array.isArray(raw) ? raw : parseJsonArray(String(raw ?? ""));
    const encodedItems = items.map((item) => encodeAbiValue(child, item));
    const packed = concatBytes([
      encodeLength(items.length),
      encodeAbiSequence(
        Array.from({ length: items.length }, () => child),
        encodedItems,
      ),
    ]);
    return { dynamic: true, head: new Uint8Array(32), tail: packed };
  }

  const text = raw == null ? "" : String(raw);
  if (param.type === "address") {
    return { dynamic: false, head: encodeAddress(text), tail: new Uint8Array() };
  }
  if (param.type === "bool") {
    return { dynamic: false, head: encodeBool(text), tail: new Uint8Array() };
  }
  if (param.type === "string") {
    return { dynamic: true, head: new Uint8Array(32), tail: encodeString(text) };
  }
  if (param.type === "bytes") {
    return { dynamic: true, head: new Uint8Array(32), tail: encodeDynamicBytes(text) };
  }
  if (/^bytes([1-9]|[12]\d|3[0-2])$/.test(param.type)) {
    return { dynamic: false, head: encodeFixedBytes(param.type, text), tail: new Uint8Array() };
  }
  if (param.type.startsWith("uint")) {
    return {
      dynamic: false,
      head: encodeUint(text, parseIntegerBits(param.type, false)),
      tail: new Uint8Array(),
    };
  }
  if (param.type.startsWith("int")) {
    return {
      dynamic: false,
      head: encodeInt(text, parseIntegerBits(param.type, true)),
      tail: new Uint8Array(),
    };
  }
  throw new Error(`unsupported-abi-type:${param.type}`);
}

function encodeAbiSequence(params: AbiParam[], values: EncodedValue[]): Uint8Array {
  let headSize = 0;
  for (let i = 0; i < params.length; i += 1) {
    headSize += values[i].dynamic ? 32 : values[i].head.length;
  }
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = headSize;
  for (let i = 0; i < params.length; i += 1) {
    const value = values[i];
    if (value.dynamic) {
      heads.push(encodeLength(tailOffset));
      tails.push(value.tail);
      tailOffset += value.tail.length;
    } else {
      heads.push(value.head);
    }
  }
  return concatBytes([...heads, ...tails]);
}

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function encodeFunctionCalldata(
  fn: AbiFunctionItem,
  argValues: Record<string, string>,
): EncodedAbiCall {
  for (const input of fn.inputs) assertSupportedType(input);
  const signature = functionSignature(fn);
  const selectorBytes = keccak256(new TextEncoder().encode(signature)).subarray(0, 4);
  const encodedArgs = fn.inputs.map((input) => encodeAbiValue(input, argValues[input.name] ?? ""));
  const body = encodeAbiSequence(fn.inputs, encodedArgs);
  const data = bytesToHex(concatBytes([selectorBytes, body]));
  return {
    signature,
    selector: bytesToHex(selectorBytes),
    data,
  };
}

function readWord(data: Uint8Array, offset: number): Uint8Array {
  if (offset + 32 > data.length) throw new Error("invalid-return-data");
  return data.subarray(offset, offset + 32);
}

function wordToBigInt(word: Uint8Array): bigint {
  let value = BigInt(0);
  for (const byte of word) value = (value << BigInt(8)) + BigInt(byte);
  return value;
}

function decodeAbiValue(param: AbiParam, data: Uint8Array, offset: number): { value: string; next: number } {
  assertSupportedType(param);
  if (isDynamicAbiType(param)) {
    const relative = Number(wordToBigInt(readWord(data, offset)));
    const absolute = relative;
    const decoded = decodeDynamicAbiValue(param, data, absolute);
    return { value: decoded, next: offset + 32 };
  }
  if (param.type === "tuple") {
    const components = param.components || [];
    let cursor = offset;
    const result: Record<string, string> = {};
    for (const component of components) {
      const decoded = decodeAbiValue(component, data, cursor);
      result[component.name] = decoded.value;
      cursor = decoded.next;
    }
    return { value: JSON.stringify(result), next: cursor };
  }
  const word = readWord(data, offset);
  if (param.type === "address") {
    return { value: `0x${bytesToHex(word.subarray(12)).slice(2)}`, next: offset + 32 };
  }
  if (param.type === "bool") {
    return { value: wordToBigInt(word) === BigInt(0) ? "false" : "true", next: offset + 32 };
  }
  if (/^bytes([1-9]|[12]\d|3[0-2])$/.test(param.type)) {
    const size = Number(param.type.slice("bytes".length));
    return { value: bytesToHex(word.subarray(0, size)), next: offset + 32 };
  }
  if (param.type.startsWith("uint")) {
    return { value: wordToBigInt(word).toString(10), next: offset + 32 };
  }
  if (param.type.startsWith("int")) {
    const full = wordToBigInt(word);
    const fullSign = BigInt(1) << BigInt(255);
    const value = full >= fullSign ? full - (BigInt(1) << BigInt(256)) : full;
    return { value: value.toString(10), next: offset + 32 };
  }
  throw new Error(`unsupported-abi-type:${param.type}`);
}

function decodeDynamicAbiValue(param: AbiParam, data: Uint8Array, offset: number): string {
  if (param.type === "string" || param.type === "bytes") {
    const length = Number(wordToBigInt(readWord(data, offset)));
    const start = offset + 32;
    const slice = data.subarray(start, start + length);
    if (param.type === "string") return new TextDecoder().decode(slice);
    return bytesToHex(slice);
  }
  if (param.type.endsWith("[]")) {
    const length = Number(wordToBigInt(readWord(data, offset)));
    const child = {
      name: param.name,
      type: param.type.slice(0, -2),
      components: param.components,
    };
    const values: string[] = [];
    let cursor = offset + 32;
    if (isDynamicAbiType(child)) {
      for (let i = 0; i < length; i += 1) {
        const relative = Number(wordToBigInt(readWord(data, cursor)));
        values.push(decodeDynamicAbiValue(child, data, offset + 32 + relative));
        cursor += 32;
      }
    } else {
      for (let i = 0; i < length; i += 1) {
        const decoded = decodeAbiValue(child, data, cursor);
        values.push(decoded.value);
        cursor = decoded.next;
      }
    }
    return JSON.stringify(values);
  }
  if (param.type === "tuple") {
    const components = param.components || [];
    let cursor = offset;
    const result: Record<string, string> = {};
    for (const component of components) {
      if (isDynamicAbiType(component)) {
        const relative = Number(wordToBigInt(readWord(data, cursor)));
        result[component.name] = decodeDynamicAbiValue(component, data, offset + relative);
        cursor += 32;
      } else {
        const decoded = decodeAbiValue(component, data, cursor);
        result[component.name] = decoded.value;
        cursor = decoded.next;
      }
    }
    return JSON.stringify(result);
  }
  const fixedArray = param.type.match(/^(.*)\[(\d+)\]$/);
  if (fixedArray) {
    const length = Number(fixedArray[2]);
    const child = {
      name: param.name,
      type: fixedArray[1],
      components: param.components,
    };
    const values: string[] = [];
    let cursor = offset;
    for (let i = 0; i < length; i += 1) {
      if (isDynamicAbiType(child)) {
        const relative = Number(wordToBigInt(readWord(data, cursor)));
        values.push(decodeDynamicAbiValue(child, data, offset + relative));
        cursor += 32;
      } else {
        const decoded = decodeAbiValue(child, data, cursor);
        values.push(decoded.value);
        cursor = decoded.next;
      }
    }
    return JSON.stringify(values);
  }
  throw new Error(`unsupported-abi-type:${param.type}`);
}

export function decodeFunctionResult(fn: AbiFunctionItem, dataHex: string): string[] {
  if (fn.outputs.length === 0) return [];
  const normalized = dataHex.trim();
  if (!normalized || normalized === "0x") return [];
  const data = hexToBytes(normalized);
  const values: string[] = [];
  let offset = 0;
  for (const output of fn.outputs) {
    if (isDynamicAbiType(output)) {
      const relative = Number(wordToBigInt(readWord(data, offset)));
      values.push(decodeDynamicAbiValue(output, data, relative));
      offset += 32;
    } else {
      const decoded = decodeAbiValue(output, data, offset);
      values.push(decoded.value);
      offset = decoded.next;
    }
  }
  return values;
}

export function isLikelyEvmAddress(value: string): boolean {
  return ADDRESS_RE.test(value.trim());
}

export function isUnsignedIntegerAbiType(type: string): boolean {
  return /^uint(\d+)?$/.test(type);
}

/**
 * Convert a human decimal amount into an integer string in token base units.
 * Example: ("1.5", 6) => "1500000"
 */
export function parseDecimalAmountToUint(amount: string, decimals: number): string {
  const trimmed = amount.trim();
  if (!trimmed) return "";
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 78) {
    throw new Error("invalid-decimals");
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("invalid-decimal-amount");
  }
  const [wholeRaw, fractionRaw = ""] = trimmed.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  if (fractionRaw.length > decimals) {
    throw new Error("too-many-fraction-digits");
  }
  const fraction = fractionRaw.padEnd(decimals, "0");
  const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return combined;
}

/**
 * Format an integer base-unit string into a human decimal amount.
 * Example: ("1500000", 6) => "1.5"
 */
export function formatUintToDecimalAmount(raw: string, decimals: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) {
    throw new Error("invalid-uint");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 78) {
    throw new Error("invalid-decimals");
  }
  const asDecimal = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? BigInt(trimmed).toString(10)
    : trimmed.replace(/^0+(?=\d)/, "") || "0";
  if (decimals === 0) return asDecimal;
  const padded = asDecimal.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function defaultTokenDecimalsForArg(name: string): number {
  const lower = name.trim().toLowerCase();
  if (/(usdg|usdc|usdt|usd)/.test(lower)) return 6;
  if (/(eth|weth|wei)/.test(lower)) return 18;
  if (/(amount|value|qty|quantity|balance|profit)/.test(lower)) return 6;
  return 18;
}
