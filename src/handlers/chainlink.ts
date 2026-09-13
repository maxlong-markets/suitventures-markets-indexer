import { indexer, type QuoteFeed } from "envio";
import { quoteForFeed } from "../lib/quotes";
import { ensureQuote } from "./shared";

indexer.contractRegister({ contract: "ChainlinkProxy", event: "AggregatorConfirmed" }, async ({ event, context }) => {
  context.chain.ChainlinkAggregator.add(event.params.latest);
});

indexer.onEvent(
  { contract: "ChainlinkProxy", event: "AggregatorConfirmed", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const row = quoteForFeed(event.srcAddress);
    if (!row || row.chainlinkDecimals === null) return;
    const quote = await ensureQuote(context, row.address, event.block.timestamp);
    const feed: QuoteFeed = {
      id: event.params.latest.toLowerCase(),
      quote_id: quote.id,
      decimals: row.chainlinkDecimals,
      proxy: event.srcAddress.toLowerCase(),
    };
    context.QuoteFeed.set(feed);
  },
);

indexer.onEvent(
  { contract: "ChainlinkAggregator", event: "AnswerUpdated", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const aggregator = event.srcAddress.toLowerCase();
    let feed = await context.QuoteFeed.get(aggregator);
    if (!feed) {
      // Static aggregator from config/quotes.json, seen before any AggregatorConfirmed.
      const row = quoteForFeed(aggregator);
      if (!row || row.chainlinkDecimals === null || !row.chainlinkProxy) return;
      const quote = await ensureQuote(context, row.address, event.block.timestamp);
      feed = { id: aggregator, quote_id: quote.id, decimals: row.chainlinkDecimals, proxy: row.chainlinkProxy };
      context.QuoteFeed.set(feed);
    }
    if (event.params.current <= 0n) return; // Chainlink reports errors as non-positive answers
    context.QuotePrice.set({
      id: feed.quote_id,
      quote_id: feed.quote_id,
      usdPrice: Number(event.params.current) / 10 ** feed.decimals,
      updatedAt: Number(event.params.updatedAt),
      aggregator,
    });
  },
);
