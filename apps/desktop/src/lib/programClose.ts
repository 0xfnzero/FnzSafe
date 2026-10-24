export interface ProgramClosePreview {
  preview_id: string;
  wallet_id: string;
  program_id: string;
  programdata_address: string;
  authority: string;
  recipient: string;
  network: string;
  genesis_hash: string;
  refundable_lamports: string;
  retained_program_lamports: string;
  estimated_fee_lamports: string;
  context_slot: number;
  expires_in_seconds: number;
}

export function lamportsAsSol(value: string): string {
  const amount = BigInt(value);
  const sign = amount < BigInt(0) ? "-" : "";
  const absolute = amount < BigInt(0) ? -amount : amount;
  return `${sign}${absolute / BigInt(1_000_000_000)}.${(absolute % BigInt(1_000_000_000)).toString().padStart(9, "0")}`;
}

export function canConfirmProgramClose(
  preview: ProgramClosePreview | null,
  walletId: string,
  programId: string,
  confirmation: string,
  acknowledged: boolean,
): boolean {
  return Boolean(preview && preview.wallet_id === walletId && preview.program_id === programId
    && confirmation === preview.program_id && acknowledged);
}
