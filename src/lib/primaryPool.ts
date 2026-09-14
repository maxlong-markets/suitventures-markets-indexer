import { toUnits } from "./price";

export type PoolRank = {
  id: string;
  quoteId: string;
  tvlToken: bigint | undefined;
  tvlQuote: bigint | undefined;
  priceQuote: number;
  tokenDecimals: number;
  quoteDecimals: number;
  swapCount: number;
  createdAt: number;
};

/** Highest USD TVL, then swap count, then earliest pool (spec section 5). */
export function choosePrimaryPool(
  pools: PoolRank[],
  usdPrice: (quoteId: string) => number | undefined,
): string | undefined {
  if (pools.length === 0) return undefined;
  const scored = pools.map((p) => {
    const hasTvl = p.tvlToken !== undefined && p.tvlQuote !== undefined;
    const usd = usdPrice(p.quoteId) ?? 0;
    const tvlQuoteUnits = hasTvl
      ? toUnits(p.tvlQuote!, p.quoteDecimals) + toUnits(p.tvlToken!, p.tokenDecimals) * p.priceQuote
      : 0;
    return { p, tvlUsd: tvlQuoteUnits * usd };
  });
  scored.sort((a, b) =>
    b.tvlUsd - a.tvlUsd ||
    b.p.swapCount - a.p.swapCount ||
    a.p.createdAt - b.p.createdAt ||
    a.p.id.localeCompare(b.p.id),
  );
  return scored[0]!.p.id;
}
