import { indexer, type QuoteFeed } from "envio";
import { quoteForFeed } from "../lib/quotes";
import { ZERO_ADDRESS } from "../lib/constants";
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
    const proxy = event.srcAddress.toLowerCase();
    const latest = event.params.latest.toLowerCase();
    // The rotated-to aggregator is assumed to keep the quote's configured decimals: this
    // handler is offline (no RPC), so it has no way to call the new aggregator's own
    // `decimals()` to confirm it.
    const latestFeed: QuoteFeed = { id: latest, quote_id: quote.id, decimals: row.chainlinkDecimals, proxy, active: true };
    context.QuoteFeed.set(latestFeed);
    const previous = event.params.previous.toLowerCase();
    // A re-confirmation of the current aggregator (previous === latest) must never
    // deactivate it: without this guard, the row just written active above (same id)
    // would be immediately overwritten inactive by the block below.
    if (previous !== ZERO_ADDRESS && previous !== latest) {
      // Deactivate the outgoing aggregator so a later AnswerUpdated from it (it stays
      // statically registered and can keep emitting) can't overwrite the new aggregator's
      // price. Create its row if AnswerUpdated never lazily created one below, so that lazy
      // path can never rebuild it as active.
      const existingPrevious = await context.QuoteFeed.get(previous);
      const previousFeed: QuoteFeed = existingPrevious
        ? { ...existingPrevious, active: false }
        : { id: previous, quote_id: quote.id, decimals: row.chainlinkDecimals, proxy, active: false };
      context.QuoteFeed.set(previousFeed);
    }
  },
);

indexer.onEvent(
  { contract: "ChainlinkAggregator", event: "AnswerUpdated", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const aggregator = event.srcAddress.toLowerCase();
    let feed = await context.QuoteFeed.get(aggregator);
    if (!feed) {
      // Static aggregator from config/quotes.json, seen before any AggregatorConfirmed. This
      // also covers a same-block gap: if a freshly-rotated-to aggregator's own first
      // AnswerUpdated is ordered before the AggregatorConfirmed that registers its QuoteFeed
      // row, `quoteForFeed` won't recognize it either (it isn't in static config), so the
      // event is dropped here and the quote keeps its old price until the new aggregator's
      // next round.
      const row = quoteForFeed(aggregator);
      if (!row || row.chainlinkDecimals === null || !row.chainlinkProxy) return;
      const quote = await ensureQuote(context, row.address, event.block.timestamp);
      feed = { id: aggregator, quote_id: quote.id, decimals: row.chainlinkDecimals, proxy: row.chainlinkProxy, active: true };
      context.QuoteFeed.set(feed);
    }
    if (!feed.active) return; // rotated away from; the current aggregator's feed now owns this quote's price
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
