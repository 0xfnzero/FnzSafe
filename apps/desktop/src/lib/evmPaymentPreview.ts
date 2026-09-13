export interface EvmPaymentPreviewExpectation {
  chainId: number;
  walletAddress: string;
  recipient: string;
  amountAtomic: string;
  tokenContract: string | null;
}

function isAtomicInteger(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function normalizedOptionalAddress(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

export function isMatchingEvmPaymentPreview(
  value: unknown,
  expected: EvmPaymentPreviewExpectation,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Record<string, unknown>;
  const chain = preview.chain;
  if (!chain || typeof chain !== "object" || Array.isArray(chain)) return false;
  const chainConfig = chain as Record<string, unknown>;
  const expectedToken = expected.tokenContract?.toLowerCase() ?? null;
  return typeof preview.preview_id === "string"
    && preview.preview_id.length >= 16
    && chainConfig.chain_id === expected.chainId
    && sameAddress(preview.wallet_address, expected.walletAddress)
    && sameAddress(preview.recipient, expected.recipient)
    && normalizedOptionalAddress(preview.token_contract) === expectedToken
    && preview.amount_wei_or_units === expected.amountAtomic
    && isAtomicInteger(preview.gas_limit)
    && isAtomicInteger(preview.gas_price_wei)
    && isAtomicInteger(preview.nonce)
    && isAtomicInteger(preview.estimated_fee_wei)
    && (preview.max_fee_per_gas_wei == null || isAtomicInteger(preview.max_fee_per_gas_wei))
    && (preview.max_priority_fee_per_gas_wei == null || isAtomicInteger(preview.max_priority_fee_per_gas_wei))
    && typeof preview.fee_model === "string"
    && Array.isArray(preview.warnings);
}
