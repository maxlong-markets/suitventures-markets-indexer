import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

// The AI/NVDA pool's Initialize is confirmed at block 9721433 (HyperSync,
// Sep 13, 2026); AI (currency0) is 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18.
// A real swap block is supplied via ENVIO_TEST_SWAP_BLOCK (61927786 has 2
// AI/NVDA swaps per HyperSync) so this file never hardcodes it.
const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
const SWAP_BLOCK = Number(process.env.ENVIO_TEST_SWAP_BLOCK ?? "0");
const swapBlockIsValid = Number.isInteger(SWAP_BLOCK) && SWAP_BLOCK > 0;

// A real invocation (npm run test:live) must fail fast with one clear
// message when it's missing what it needs, rather than failing confusingly
// deep inside a chain read.
if (process.env.ENVIO_LIVE_TEST === "1" && (!process.env.ENVIO_API_TOKEN || !process.env.ENVIO_RPC_URL || !swapBlockIsValid)) {
  throw new Error("test:live needs ENVIO_API_TOKEN and ENVIO_RPC_URL in .env and a numeric ENVIO_TEST_SWAP_BLOCK");
}

// This suite only runs against real chain data: plain `npm test` blanks
// ENVIO_API_TOKEN (see vitest.config.ts), so it's skipped there. `npm run
// test:live` sets ENVIO_LIVE_TEST=1, which keeps ENVIO_RPC_URL/ENVIO_API_TOKEN
// from `.env`; ENVIO_TEST_SWAP_BLOCK must also be supplied on that
// invocation (checked above).
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

    await indexer.process({ chains: { 4663: { startBlock: SWAP_BLOCK, endBlock: SWAP_BLOCK } } });
    const after = await indexer.Pool.getOrThrow(POOL);
    t.expect(after.swapCount).toBeGreaterThan(0);
    // AI traded around 0.00087 NVDA on Sep 10 to 12, 2026; a wide band absorbs drift.
    t.expect(after.priceQuote).toBeGreaterThan(0.0002);
    t.expect(after.priceQuote).toBeLessThan(0.005);
    const swaps = await indexer.Swap.getAll();
    t.expect(swaps[0]!.wallet.startsWith("0x")).toBe(true);
  }, 120_000);
});
