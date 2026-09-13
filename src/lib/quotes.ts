import quotesJson from "../../config/quotes.json" with { type: "json" };

export type QuoteRow = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainlinkProxy: string | null;
  chainlinkAggregator: string | null;
  chainlinkDecimals: number | null;
};

/** Quote allowlist rows, addresses lowercased. Adding a quote is a row here plus a backfill. */
export const QUOTES: QuoteRow[] = (quotesJson as QuoteRow[]).map((q) => ({
  ...q,
  address: q.address.toLowerCase(),
  chainlinkProxy: q.chainlinkProxy?.toLowerCase() ?? null,
  chainlinkAggregator: q.chainlinkAggregator?.toLowerCase() ?? null,
}));

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
