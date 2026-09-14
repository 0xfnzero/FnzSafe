export interface EvmAssetSendContext {
  chainId: number;
  kind: "native" | "erc20";
  tokenContract: string | null;
  decimals: number;
  symbol: string;
  chainName: string;
  balance: string;
  logoUri?: string;
}

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function resolveEvmAssetSendContext(
  formData: Record<string, unknown>,
): EvmAssetSendContext | null {
  if (Number(formData.unified_evm_send) !== 1) return null;

  const chainId = Number(formData.evm_asset_chain_id);
  const decimals = Number(formData.evm_asset_decimals);
  const kind = formData.evm_asset_kind;
  const symbol = String(formData.evm_asset_symbol || "").trim();
  const chainName = String(formData.evm_asset_chain || "").trim();
  const balance = String(formData.evm_asset_balance || "").trim();

  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("The selected asset has an invalid EVM network");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("The selected asset has invalid decimals");
  }
  if (kind !== "native" && kind !== "erc20") {
    throw new Error("The selected asset type is invalid");
  }
  if (!symbol || !chainName) {
    throw new Error("The selected asset is missing identity information");
  }

  let tokenContract: string | null = null;
  if (kind === "erc20") {
    const contract = String(formData.evm_asset_contract || "").trim();
    if (!EVM_ADDRESS_PATTERN.test(contract)) {
      throw new Error("The selected token has an invalid contract address");
    }
    tokenContract = contract;
  }

  const logoUri = String(formData.evm_asset_logo_uri || "").trim();
  return {
    chainId,
    kind,
    tokenContract,
    decimals,
    symbol,
    chainName,
    balance,
    ...(logoUri ? { logoUri } : {}),
  };
}
