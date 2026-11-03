/** Default names keep increasing across unnamed and custom-named wallet groups. */
export function nextWalletName(wallets: ReadonlyArray<{ name: string }>): string {
  let maximum = wallets.length;
  for (const wallet of wallets) {
    const match = /^wallet[\s-]+(\d+)$/i.exec(wallet.name.trim());
    const number = match ? Number(match[1]) : 0;
    if (Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER) maximum = Math.max(maximum, number);
  }
  return `Wallet ${maximum + 1}`;
}
