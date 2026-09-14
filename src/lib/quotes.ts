import quotesJson from "../../config/quotes.json" with { type: "json" };
import { USDG } from "./constants";

export type QuoteRow = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainlinkProxy: string | null;
  chainlinkAggregator: string | null;
  chainlinkDecimals: number | null;
};

/**
 * Throws on a malformed allowlist instead of letting bad config silently
 * produce wrong prices or a broken lookup later: a duplicate address (the
 * `Map` below would just drop one silently), an out-of-range decimals value
 * (every amount computed from it would be wrong), a one-sided Chainlink
 * pairing (a proxy with no aggregator to read, or the reverse), or a missing
 * or mis-decimaled USDG row (its price is pinned at 1 assuming 6 decimals
 * elsewhere — see shared.ts's ensureQuote).
 */
export function validateQuotes(rows: QuoteRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const address = row.address.toLowerCase();
    if (seen.has(address)) {
      throw new Error(`config/quotes.json: duplicate address ${address}`);
    }
    seen.add(address);
    if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 255) {
      throw new Error(`config/quotes.json: ${address} has an invalid decimals value ${JSON.stringify(row.decimals)}`);
    }
    if (Boolean(row.chainlinkProxy) !== Boolean(row.chainlinkAggregator)) {
      throw new Error(`config/quotes.json: ${address} has a chainlinkProxy/chainlinkAggregator without the other`);
    }
  }
  const usdgRow = rows.find((row) => row.address.toLowerCase() === USDG);
  if (!usdgRow) {
    throw new Error(`config/quotes.json: missing the USDG row (${USDG})`);
  }
  if (usdgRow.decimals !== 6) {
    throw new Error(`config/quotes.json: USDG's decimals must be 6, got ${usdgRow.decimals}`);
  }
}

/** Quote allowlist rows, addresses lowercased. Adding a quote is a row here plus a backfill. */
export const QUOTES: QuoteRow[] = (quotesJson as QuoteRow[]).map((q) => ({
  ...q,
  address: q.address.toLowerCase(),
  chainlinkProxy: q.chainlinkProxy?.toLowerCase() ?? null,
  chainlinkAggregator: q.chainlinkAggregator?.toLowerCase() ?? null,
}));
validateQuotes(QUOTES);

const BY_ADDRESS = new Map(QUOTES.map((q) => [q.address, q]));

export const QUOTE_ADDRESSES: string[] = QUOTES.map((q) => q.address);

export function isQuote(address: string): boolean {
  return BY_ADDRESS.has(address.toLowerCase());
}

export function quoteRow(address: string): QuoteRow | undefined {
  return BY_ADDRESS.get(address.toLowerCase());
}

/** Quote row for a Chainlink proxy or aggregator address, if any. */
export function quoteForFeed(feedAddress: string): QuoteRow | undefined {
  const a = feedAddress.toLowerCase();
  return QUOTES.find((q) => q.chainlinkProxy === a || q.chainlinkAggregator === a);
}
