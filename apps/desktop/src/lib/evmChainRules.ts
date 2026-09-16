export function isArcChain(chainId: number): boolean {
  return chainId === 5042 || chainId === 5042002;
}

export function isNativeTokenAlias(chainId: number, address: string): boolean {
  return isArcChain(chainId) && address.trim().toLowerCase() === "0x3600000000000000000000000000000000000000";
}

export function evmFeeLabel(chainId: number, raw: string): string {
  if (!isArcChain(chainId)) return `${raw} wei`;
  if (!/^\d+$/.test(raw)) return "-";
  const padded = BigInt(raw).toString().padStart(19, "0");
  const whole = padded.slice(0, -18);
  const fraction = padded.slice(-18).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}
