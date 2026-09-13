import { type Quote, type Token, type EvmOnEventContext } from "envio";
import { quoteRow } from "../lib/quotes";
import { choosePrimaryPool } from "../lib/primaryPool";
import { USDG } from "../lib/constants";

// envio's generic `indexer.onEvent` signature does not yield a usable context type
// through TypeScript's `Parameters<>`/instantiation-expression utilities. `EvmOnEventContext`
// is envio's exported handler context type: it doesn't vary by contract/event, only by
// the project config, and its default type parameter already resolves to this project's
// generated config.
export type HandlerContext = EvmOnEventContext;

/** Seeds the Quote row (and USDG's pinned price) the first time a quote is seen. */
export async function ensureQuote(context: HandlerContext, address: string, timestamp: number): Promise<Quote> {
  const id = address.toLowerCase();
  const existing = await context.Quote.get(id);
  if (existing) return existing;
  const row = quoteRow(id);
  if (!row) throw new Error(`ensureQuote called for non-quote ${address}`);
  const quote: Quote = { id, address, symbol: row.symbol, name: row.name, decimals: row.decimals, enabled: true };
  context.Quote.set(quote);
  if (id === USDG) {
    context.QuotePrice.set({ id, quote_id: id, usdPrice: 1, updatedAt: timestamp, aggregator: "pinned" });
  }
  return quote;
}

/** Token row that Transfer or Initialize can create first; metadata is filled by Initialize. */
export async function ensureToken(context: HandlerContext, address: string, timestamp: number): Promise<Token> {
  const id = address.toLowerCase();
  const existing = await context.Token.get(id);
  if (existing) return existing;
  const token: Token = {
    id, address, symbol: address.slice(0, 6), name: address, decimals: 18, metadataLoaded: false,
    historyLoaded: false,
    totalSupply: 0n, holdersCount: 0, poolCount: 0, origin: "Other", primaryPool_id: undefined, createdAt: timestamp,
  };
  context.Token.set(token);
  return token;
}

/** Re-picks primaryPool (and the token's origin) from the token's pools. */
export async function recomputePrimaryPool(context: HandlerContext, tokenId: string): Promise<void> {
  const token = await context.Token.get(tokenId);
  if (!token) return;
  const pools = await context.Pool.getWhere({ token_id: { _eq: tokenId } });
  if (pools.length === 0) return;
  const prices = new Map<string, number | undefined>();
  const quoteDecimals = new Map<string, number>();
  for (const p of pools) {
    if (!prices.has(p.quote_id)) prices.set(p.quote_id, (await context.QuotePrice.get(p.quote_id))?.usdPrice);
    if (!quoteDecimals.has(p.quote_id)) quoteDecimals.set(p.quote_id, (await context.Quote.get(p.quote_id))?.decimals ?? 18);
  }
  const best = choosePrimaryPool(
    pools.map((p) => ({
      id: p.id, quoteId: p.quote_id, tvlToken: p.tvlToken, tvlQuote: p.tvlQuote, priceQuote: p.priceQuote,
      tokenDecimals: token.decimals, quoteDecimals: quoteDecimals.get(p.quote_id) ?? 18,
      swapCount: p.swapCount, createdAt: p.createdAt,
    })),
    (q) => prices.get(q),
  );
  const bestPool = pools.find((p) => p.id === best);
  if (bestPool && (token.primaryPool_id !== best || token.origin !== bestPool.origin)) {
    context.Token.set({ ...token, primaryPool_id: best, origin: bestPool.origin });
  }
}
