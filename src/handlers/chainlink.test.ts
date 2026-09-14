import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";
import { getAddress } from "viem";
import { QUOTES } from "../lib/quotes";

// Simulated Chainlink items must use blocks at or above the ChainlinkAggregator start_block
// (55799704), because the simulator counts a static contract only from its start block.
const BASE_BLOCK = 55_800_000;

const feedQuotes = QUOTES.filter((q) => q.chainlinkProxy && q.chainlinkAggregator && q.chainlinkDecimals !== null);
const feedQuote = feedQuotes[0];

// EIP-55 checksummed, not config's lowercase casing: a missing `.toLowerCase()` in the handler
// would fail these tests instead of passing by coincidence.
const AGGREGATOR = feedQuote ? getAddress(feedQuote.chainlinkAggregator!) : undefined;
const PROXY = feedQuote ? getAddress(feedQuote.chainlinkProxy!) : undefined;
const NEW_AGG = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");

function answerUpdated(srcAddress: Address, current: bigint, roundId: bigint, updatedAt: bigint, block: number) {
  return {
    contract: "ChainlinkAggregator" as const,
    event: "AnswerUpdated" as const,
    srcAddress,
    block: { number: block, timestamp: 1_700_000_000 + block },
    params: { current, roundId, updatedAt },
  };
}

function aggregatorConfirmed(srcAddress: Address, previous: Address, latest: Address, block: number) {
  return {
    contract: "ChainlinkProxy" as const,
    event: "AggregatorConfirmed" as const,
    srcAddress,
    block: { number: block, timestamp: 1_700_000_000 + block },
    params: { previous, latest },
  };
}

describe.skipIf(!feedQuote)("Chainlink", () => {
  it("writes a QuotePrice from AnswerUpdated on a configured aggregator", async (t) => {
    const indexer = createTestIndexer();
    const dec = feedQuote!.chainlinkDecimals!;
    await indexer.process({
      chains: {
        4663: { simulate: [answerUpdated(AGGREGATOR!, BigInt(Math.round(224.4 * 10 ** dec)), 1n, 1_700_000_005n, BASE_BLOCK + 10)] },
      },
    });
    const price = await indexer.QuotePrice.getOrThrow(feedQuote!.address);
    t.expect(price.usdPrice).toBeCloseTo(224.4, 6);
    t.expect(price.updatedAt).toBe(1_700_000_005);
    t.expect(price.aggregator).toBe(AGGREGATOR!.toLowerCase());
  });

  it("writes no QuotePrice for a non-positive answer, though the feed row may still be created", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: { 4663: { simulate: [answerUpdated(AGGREGATOR!, 0n, 1n, 1_700_000_006n, BASE_BLOCK + 11)] } },
    });
    t.expect(await indexer.QuotePrice.get(feedQuote!.address)).toBeUndefined();
    const feed = await indexer.QuoteFeed.getOrThrow(AGGREGATOR!.toLowerCase());
    t.expect(feed.active).toBe(true);
  });

  it("registers a rotated aggregator and maps it to the quote", async (t) => {
    const indexer = createTestIndexer();
    const dec = feedQuote!.chainlinkDecimals!;
    await indexer.process({
      chains: {
        4663: {
          simulate: [
            aggregatorConfirmed(PROXY!, AGGREGATOR!, NEW_AGG, BASE_BLOCK + 20),
            answerUpdated(NEW_AGG, BigInt(Math.round(230 * 10 ** dec)), 2n, 1_700_000_021n, BASE_BLOCK + 21),
          ],
        },
      },
    });
    t.expect(indexer.chains[4663].ChainlinkAggregator.addresses.map((a) => a.toLowerCase())).toContain(
      NEW_AGG.toLowerCase(),
    );
    const feed = await indexer.QuoteFeed.getOrThrow(NEW_AGG.toLowerCase());
    t.expect(feed.quote_id).toBe(feedQuote!.address);
    t.expect(feed.decimals).toBe(dec);
    t.expect(feed.proxy).toBe(PROXY!.toLowerCase());
    t.expect(feed.active).toBe(true);
    const price = await indexer.QuotePrice.getOrThrow(feedQuote!.address);
    t.expect(price.usdPrice).toBeCloseTo(230, 6);
    t.expect(price.aggregator).toBe(NEW_AGG.toLowerCase());
  });

  it("keeps the new aggregator's price when the rotated-away aggregator answers again later", async (t) => {
    const indexer = createTestIndexer();
    const dec = feedQuote!.chainlinkDecimals!;
    await indexer.process({
      chains: {
        4663: {
          simulate: [
            // Established before the rotation, so AGGREGATOR's QuoteFeed row already
            // exists (active) when AggregatorConfirmed deactivates it below — this
            // exercises the "flip an existing row" branch, not just "create one
            // inactive from scratch".
            answerUpdated(AGGREGATOR!, BigInt(Math.round(224 * 10 ** dec)), 1n, 1_700_000_019n, BASE_BLOCK + 19),
            aggregatorConfirmed(PROXY!, AGGREGATOR!, NEW_AGG, BASE_BLOCK + 20),
            answerUpdated(NEW_AGG, BigInt(Math.round(230 * 10 ** dec)), 2n, 1_700_000_021n, BASE_BLOCK + 21),
            // The old aggregator is still statically registered and can still emit; its feed
            // row must now be inactive so this late answer doesn't win.
            answerUpdated(AGGREGATOR!, BigInt(Math.round(225 * 10 ** dec)), 3n, 1_700_000_022n, BASE_BLOCK + 22),
          ],
        },
      },
    });
    const price = await indexer.QuotePrice.getOrThrow(feedQuote!.address);
    t.expect(price.usdPrice).toBeCloseTo(230, 6);
    t.expect(price.aggregator).toBe(NEW_AGG.toLowerCase());
    const oldFeed = await indexer.QuoteFeed.getOrThrow(AGGREGATOR!.toLowerCase());
    t.expect(oldFeed.active).toBe(false);
    const newFeed = await indexer.QuoteFeed.getOrThrow(NEW_AGG.toLowerCase());
    t.expect(newFeed.active).toBe(true);
  });

  // Re-confirming the current aggregator (previous === latest) must never
  // deactivate it — previously this always ran the deactivation branch
  // whenever `previous` wasn't the zero address, even when it was the very
  // aggregator just (re)confirmed as latest, immediately overwriting the
  // active row it had just written with an inactive one sharing the same id.
  it("does not deactivate an aggregator that re-confirms itself", async (t) => {
    const indexer = createTestIndexer();
    const dec = feedQuote!.chainlinkDecimals!;
    await indexer.process({
      chains: {
        4663: {
          simulate: [
            aggregatorConfirmed(PROXY!, AGGREGATOR!, AGGREGATOR!, BASE_BLOCK + 40),
            answerUpdated(AGGREGATOR!, BigInt(Math.round(226 * 10 ** dec)), 5n, 1_700_000_041n, BASE_BLOCK + 41),
          ],
        },
      },
    });
    const feed = await indexer.QuoteFeed.getOrThrow(AGGREGATOR!.toLowerCase());
    t.expect(feed.active).toBe(true);
    const price = await indexer.QuotePrice.getOrThrow(feedQuote!.address);
    t.expect(price.usdPrice).toBeCloseTo(226, 6);
    t.expect(price.aggregator).toBe(AGGREGATOR!.toLowerCase());
  });

  it("maps a second, distinct aggregator to its own quote rather than the first", async (t) => {
    const indexer = createTestIndexer();
    const second = feedQuotes[1]!;
    const dec = second.chainlinkDecimals!;
    const aggregator = getAddress(second.chainlinkAggregator!);
    await indexer.process({
      chains: {
        4663: { simulate: [answerUpdated(aggregator, BigInt(Math.round(88.8 * 10 ** dec)), 1n, 1_700_000_030n, BASE_BLOCK + 30)] },
      },
    });
    const price = await indexer.QuotePrice.getOrThrow(second.address);
    t.expect(price.usdPrice).toBeCloseTo(88.8, 6);
    t.expect(price.aggregator).toBe(aggregator.toLowerCase());
    t.expect(await indexer.QuotePrice.get(feedQuote!.address)).toBeUndefined();
  });
});
