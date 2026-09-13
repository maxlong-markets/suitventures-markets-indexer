import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

// Task 11 controller rulings: the AI/NVDA pool's Initialize is confirmed at
// block 9721433 (HyperSync check, Sep 13, 2026); AI (currency0) at
// 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18; a real swap block is supplied
// via ENVIO_TEST_SWAP_BLOCK (ruling 2: 61927786, which HyperSync shows has 2
// AI/NVDA swaps) so this file never hardcodes it.
const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const SWAP_BLOCK = Number(process.env.ENVIO_TEST_SWAP_BLOCK ?? "0");

// Runs only against real chain data: `npm test` blanks ENVIO_API_TOKEN (see
// vitest.config.ts), so this suite is skipped there. `npm run test:live` sets
// ENVIO_LIVE_TEST=1, which keeps ENVIO_RPC_URL/ENVIO_API_TOKEN from `.env`
// (ruling 3); ENVIO_TEST_SWAP_BLOCK must also be supplied on that invocation.
describe.skipIf(!process.env.ENVIO_API_TOKEN || !SWAP_BLOCK)("live: AI/NVDA", () => {
  it("discovers the pool and prices a real swap near DexScreener", async (t) => {
    const indexer = createTestIndexer();

    // A single createTestIndexer() instance keeps its entities, registered
    // contract addresses and per-chain progress across process() calls (see
    // node_modules/envio/src/TestIndexer.res: `state` is captured once in the
    // closure created by createTestIndexer and mutated in place by each
    // process() run) — so the Pool/Token discovered here are still present
    // for the second process() call below.
    await indexer.process({ chains: { 4663: { startBlock: 9_721_433, endBlock: 9_721_433 } } });
    const pool = await indexer.Pool.getOrThrow(POOL);
    t.expect(pool.origin).toBe("LONG");
    t.expect(pool.token_id).toBe(AI);
    t.expect(pool.tokenIsCurrency0).toBe(true);
    const token = await indexer.Token.getOrThrow(AI);
    t.expect(token.symbol).toBe("AI");
    // Diagnostic only (not asserted further, per ruling 6): shows whether the
    // real RPC metadata read and the Task 9b pre-registration history replay
    // actually ran, for the task report.
    console.log(
      `[live] after Initialize(${9_721_433}): symbol=${token.symbol} metadataLoaded=${token.metadataLoaded} ` +
        `historyLoaded=${token.historyLoaded} totalSupply=${token.totalSupply} holdersCount=${token.holdersCount}`,
    );

    await indexer.process({ chains: { 4663: { startBlock: SWAP_BLOCK, endBlock: SWAP_BLOCK } } });
    const after = await indexer.Pool.getOrThrow(POOL);
    t.expect(after.swapCount).toBeGreaterThan(0);
    // AI traded around 0.00087 NVDA on Sep 10 to 12, 2026; a wide band absorbs drift.
    t.expect(after.priceQuote).toBeGreaterThan(0.0002);
    t.expect(after.priceQuote).toBeLessThan(0.005);
    const swaps = await indexer.Swap.getAll();
    t.expect(swaps[0]!.wallet.startsWith("0x")).toBe(true);
    const afterToken = await indexer.Token.getOrThrow(AI);
    // Diagnostic only, for the task report.
    console.log(
      `[live] after swap block ${SWAP_BLOCK}: priceQuote=${after.priceQuote} swapCount=${after.swapCount} ` +
        `swaps=${swaps.length} holdersCount=${afterToken.holdersCount}`,
    );
  }, 120_000);
});
