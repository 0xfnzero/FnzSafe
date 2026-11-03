import type { SafeDiscoveryPage } from "./safeMultisig.ts";

export type DiscoveryCursor = { before_block?: number; offset: number; block_span?: number };
export function nextDiscoveryCursor(page: SafeDiscoveryPage, previous: DiscoveryCursor): DiscoveryCursor | null {
  const integers = [page.from_block, page.to_block, page.latest_block, page.next_offset, page.block_span, page.unsupported];
  if (integers.some(n => !Number.isSafeInteger(n) || n < 0) || page.block_span < 1 || page.block_span > 50_000 ||
    !Array.isArray(page.accounts) || page.from_block > page.to_block || page.to_block > page.latest_block ||
    (previous.before_block !== undefined && page.to_block !== previous.before_block) ||
    page.complete !== (page.next_before_block === null)) throw new Error("Invalid Safe discovery cursor");
  if (page.complete) {
    if (page.from_block !== 0 || page.next_offset !== 0) throw new Error("Incomplete Safe discovery history");
    return null;
  }
  const next = page.next_before_block!;
  if (!Number.isSafeInteger(next) || next < 0 ||
    !((next === page.to_block && page.next_offset > previous.offset) ||
      (next === page.from_block - 1 && page.next_offset === 0))) throw new Error("Safe discovery did not advance");
  return { before_block: next, offset: page.next_offset, block_span: page.block_span };
}
