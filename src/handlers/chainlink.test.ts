import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";
import { QUOTES } from "../lib/quotes";

const feedQuote = QUOTES.find((q) => q.chainlinkProxy && q.chainlinkAggregator && q.chainlinkDecimals !== null);
const NEW_AGG = "0x9999999999999999999999999999999999999999" as Address;

// Ruling 10: `ChainlinkAggregator` is statically configured in config.yaml with
// `start_block: 55799704`, and Envio's simulate source gates every item by the
// registration's own start block (the same mechanism token.test.ts's ruling-6 note
// and poolManager.test.ts's ruling-11 note describe for dynamically-registered
// contracts) plus the address-set's start-block group for statically-configured
// ones. Below that block, an `AnswerUpdated` for a configured aggregator is
// filtered out before any handler runs. `BASE_BLOCK` sits comfortably above it;
// each item's block is `BASE_BLOCK` plus the brief's original small block number
// (10, 20, 21), which keeps the brief's relative order (the rotation's
// `AggregatorConfirmed` before the rotated aggregator's first `AnswerUpdated`)
// while clearing the start block. Block timestamps follow the
// `1_700_000_000 + block` convention already used across this suite (e.g.
// token.test.ts, poolManager.test.ts); no assertion depends on their exact value.
const BASE_BLOCK = 55_800_000;

// Simulate items type address-shaped fields (srcAddress, address-valued params) as
// the generated `Address` (`0x${string}`) rather than plain `string` — the same
// type-only cast token.test.ts and poolManager.test.ts apply to their address
// constants. `feedQuote`'s `chainlinkProxy`/`chainlinkAggregator` are plain
// `string | null` on `QuoteRow`, so they need the same cast where used as
// simulate-item address fields; this changes no value, only the static type.

describe.skipIf(!feedQuote)("Chainlink", () => {
  it("writes a QuotePrice from AnswerUpdated on a configured aggregator", async (t) => {
    const indexer = createTestIndexer();
    const dec = feedQuote!.chainlinkDecimals!;
    await indexer.process({
      chains: {
        4663: {
          simulate: [
            {
              contract: "ChainlinkAggregator" as const,
              event: "AnswerUpdated" as const,
              srcAddress: feedQuote!.chainlinkAggregator! as Address,
              block: { number: BASE_BLOCK + 10, timestamp: 1_700_000_000 + BASE_BLOCK + 10 },
              params: { current: BigInt(Math.round(224.4 * 10 ** dec)), roundId: 1n, updatedAt: 1_700_000_005n },
            },
          ],
        },
      },
    });
    const price = await indexer.QuotePrice.getOrThrow(feedQuote!.address);
    t.expect(price.usdPrice).toBeCloseTo(224.4, 6);
    t.expect(price.updatedAt).toBe(1_700_000_005);
    t.expect(price.aggregator).toBe(feedQuote!.chainlinkAggregator);
  });

  it("registers a rotated aggregator and maps it to the quote", async (t) => {
    const indexer = createTestIndexer();
    const dec = feedQuote!.chainlinkDecimals!;
    await indexer.process({
      chains: {
        4663: {
          simulate: [
            {
              contract: "ChainlinkProxy" as const,
              event: "AggregatorConfirmed" as const,
              srcAddress: feedQuote!.chainlinkProxy! as Address,
              block: { number: BASE_BLOCK + 20, timestamp: 1_700_000_000 + BASE_BLOCK + 20 },
              params: { previous: feedQuote!.chainlinkAggregator! as Address, latest: NEW_AGG },
            },
            {
              contract: "ChainlinkAggregator" as const,
              event: "AnswerUpdated" as const,
              srcAddress: NEW_AGG,
              block: { number: BASE_BLOCK + 21, timestamp: 1_700_000_000 + BASE_BLOCK + 21 },
              params: { current: BigInt(Math.round(230 * 10 ** dec)), roundId: 2n, updatedAt: 1_700_000_021n },
            },
          ],
        },
      },
    });
    t.expect(indexer.chains[4663].ChainlinkAggregator.addresses.map((a) => a.toLowerCase())).toContain(NEW_AGG);
    const feed = await indexer.QuoteFeed.getOrThrow(NEW_AGG);
    t.expect(feed.quote_id).toBe(feedQuote!.address);
    const price = await indexer.QuotePrice.getOrThrow(feedQuote!.address);
    t.expect(price.usdPrice).toBeCloseTo(230, 6);
    t.expect(price.aggregator).toBe(NEW_AGG);
  });
});
