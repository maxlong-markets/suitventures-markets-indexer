import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";
import { getAddress } from "viem";
import { amountsForLiquidityDelta } from "../lib/liquidity";
import denylist from "../../config/token-denylist.json" with { type: "json" };

// Simulate items type their address-shaped fields (srcAddress, currency0/1, hooks,
// sender, from) as the generated `Address` (`0x${string}`) rather than plain
// `string`. These constants are typed `Address` so their values satisfy that
// requirement without changing any value.
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const AI: Address = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG: Address = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WYFI: Address = "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e";
const DOPPLER: Address = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const POOL = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27";
const OTHER_TOKEN: Address = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const Q96 = 2n ** 96n;
const WALLET: Address = "0x3f8A7c21e9B4d0a6F15c8E2b7D9a4C0e1F6b9A2c";
const TX = "0x" + "ab".repeat(32);

function init(
  params: Partial<{ id: string; currency0: Address; currency1: Address; hooks: Address; sqrtPriceX96: bigint }>,
  block = 100,
) {
  return {
    contract: "PoolManager" as const,
    event: "Initialize" as const,
    srcAddress: POOL_MANAGER,
    block: { number: block, timestamp: 1_700_000_000 + block },
    params: {
      id: POOL, currency0: AI, currency1: NVDA, fee: 8388608n, tickSpacing: 8n,
      hooks: DOPPLER, sqrtPriceX96: Q96, tick: 0n, ...params,
    },
  };
}

function swap(amount0: bigint, amount1: bigint, sqrtPriceX96: bigint, block: number) {
  return {
    contract: "PoolManager" as const,
    event: "Swap" as const,
    srcAddress: POOL_MANAGER,
    block: { number: block, timestamp: 1_700_000_000 + block * 60 },
    transaction: { hash: TX, from: WALLET },
    params: { id: POOL, sender: WALLET, amount0, amount1, sqrtPriceX96, liquidity: 10n ** 18n, tick: 0n, fee: 3000n },
  };
}

function modifyLiquidity(id: string, liquidityDelta: bigint, block: number) {
  return {
    contract: "PoolManager" as const,
    event: "ModifyLiquidity" as const,
    srcAddress: POOL_MANAGER,
    block: { number: block, timestamp: 1_700_000_000 + block },
    params: {
      id, sender: WALLET, tickLower: -887272n, tickUpper: 887272n, liquidityDelta,
      salt: "0x" + "00".repeat(32),
    },
  };
}

describe("Initialize discovery", () => {
  it("tracks a pool with exactly one quote side, registers the token, labels LONG", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [init({})] } } });
    const pool = await indexer.Pool.getOrThrow(POOL);
    t.expect(pool.token_id).toBe(AI.toLowerCase());
    t.expect(pool.quote_id).toBe(NVDA.toLowerCase());
    t.expect(pool.tokenIsCurrency0).toBe(true);
    t.expect(pool.origin).toBe("LONG");
    t.expect(pool.priceQuote).toBeCloseTo(1, 9);
    const token = await indexer.Token.getOrThrow(AI.toLowerCase());
    t.expect(token.primaryPool_id).toBe(POOL);
    t.expect(token.poolCount).toBe(1);
    t.expect(token.origin).toBe("LONG");
    t.expect(indexer.chains[4663].Token.addresses.map((a) => a.toLowerCase())).toContain(AI.toLowerCase());
    const quote = await indexer.Quote.getOrThrow(NVDA.toLowerCase());
    t.expect(quote.symbol).toBe("NVDA");
  });
  it("ignores pools where both sides are quotes", async (t) => {
    const indexer = createTestIndexer();
    const id = "0x" + "11".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [init({ id, currency0: USDG, currency1: NVDA })] } } });
    t.expect(await indexer.Pool.get(id)).toBeUndefined();
  });
  it("orients a token that is currency1 and inverts the price", async (t) => {
    const indexer = createTestIndexer();
    const id = "0x" + "22".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [init({ id, currency0: NVDA, currency1: OTHER_TOKEN, hooks: ZERO, sqrtPriceX96: 2n * Q96 })] } } });
    const pool = await indexer.Pool.getOrThrow(id);
    t.expect(pool.tokenIsCurrency0).toBe(false);
    t.expect(pool.origin).toBe("Uniswap");
    t.expect(pool.priceQuote).toBeCloseTo(0.25, 9);
  });
  it("pins USDG at 1 when a USDG pool appears", async (t) => {
    const indexer = createTestIndexer();
    const id = "0x" + "33".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [init({ id, currency0: USDG, currency1: OTHER_TOKEN, hooks: ZERO })] } } });
    const price = await indexer.QuotePrice.getOrThrow(USDG);
    t.expect(price.usdPrice).toBe(1);
  });
  it("skips native currency: no ERC-20 contract to index (README D22)", async (t) => {
    const indexer = createTestIndexer();
    const id = "0x" + "44".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [init({ id, currency0: ZERO, currency1: NVDA })] } } });
    t.expect(await indexer.Pool.get(id)).toBeUndefined();
    t.expect(await indexer.Token.get(ZERO)).toBeUndefined();
    t.expect(indexer.chains[4663].Token.addresses.map((a) => a.toLowerCase())).not.toContain(ZERO);
  });

  // A spam token can be paired with USDG or a stock by anyone. Without a
  // denylist, tracking one paired with a real asset (a wrapped BTC such as
  // cbBTC, and TAO) would replay that asset's entire chain transfer history.
  // Uses the first entry of the real generated config/token-denylist.json (see
  // scripts/build-quotes.ts), so this exercises the actual production data.
  it("creates no Pool, Token or registration for a denylisted token paired with USDG", async (t) => {
    const indexer = createTestIndexer();
    const denylisted = getAddress(denylist[0]!.address) as Address; // checksum for the Address-typed simulate field
    const id = "0x" + "88".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [init({ id, currency0: denylisted, currency1: USDG, hooks: ZERO })] } } });
    t.expect(await indexer.Pool.get(id)).toBeUndefined();
    t.expect(await indexer.Token.get(denylisted.toLowerCase())).toBeUndefined();
    t.expect(indexer.chains[4663].Token.addresses.map((a) => a.toLowerCase())).not.toContain(denylisted.toLowerCase());
  });

  it("treats WYFI as a quote and pairs it with a non-quote token as that token's pool", async (t) => {
    const indexer = createTestIndexer();
    const id = "0x" + "99".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [
      init({ id, currency0: OTHER_TOKEN, currency1: WYFI, hooks: ZERO, fee: 3000n }),
    ] } } });
    const pool = await indexer.Pool.getOrThrow(id);
    t.expect(pool.token_id).toBe(OTHER_TOKEN.toLowerCase());
    t.expect(pool.quote_id).toBe(WYFI.toLowerCase());
    t.expect(pool.tokenIsCurrency0).toBe(true);
    t.expect(indexer.chains[4663].Token.addresses.map((a) => a.toLowerCase())).toContain(OTHER_TOKEN.toLowerCase());
    const quote = await indexer.Quote.getOrThrow(WYFI.toLowerCase());
    t.expect(quote.symbol).toBe("WYFI");
  });
});

describe("Swap", () => {
  it("records a buy, updates price, candles and TVL net of the swap fee", async (t) => {
    const indexer = createTestIndexer();
    // swapper receives 1000 AI (amount0 positive), pays 1 NVDA (amount1 negative); price after = 4
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),
      swap(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 101),
    ] } } });
    const pool = await indexer.Pool.getOrThrow(POOL);
    t.expect(pool.swapCount).toBe(1);
    t.expect(pool.priceQuote).toBeCloseTo(4, 9);
    t.expect(pool.tvlToken).toBe(-(1000n * 10n ** 18n));
    // The paid side (quote) nets out the 0.3% swap fee, which accrues to fee growth rather
    // than becoming pool liquidity: 1e18 * (1_000_000 - 3000) / 1_000_000 = 997n * 10n ** 15n.
    t.expect(pool.tvlQuote).toBe(997n * 10n ** 15n);
    t.expect(pool.volumeQuoteAllTime).toBeCloseTo(1, 9);
    const swaps = await indexer.Swap.getAll();
    t.expect(swaps).toHaveLength(1);
    t.expect(swaps[0]!.side).toBe("buy");
    t.expect(swaps[0]!.amountToken).toBeCloseTo(1000, 9);
    t.expect(swaps[0]!.priceQuote).toBeCloseTo(0.001, 12); // execution price 1 NVDA / 1000 AI
    t.expect(swaps[0]!.wallet).toBe(WALLET.toLowerCase());
    const candles = await indexer.Candle.getAll();
    t.expect(candles).toHaveLength(5); // one bucket per interval
    const m1 = candles.find((c) => c.interval === "m1")!;
    t.expect(m1.open).toBeCloseTo(1, 9);   // previous pool price (gapless)
    t.expect(m1.close).toBeCloseTo(4, 9);
    t.expect(m1.high).toBeCloseTo(4, 9);
    t.expect(m1.low).toBeCloseTo(1, 9);
    t.expect(m1.volumeQuote).toBeCloseTo(1, 9);
    t.expect(m1.trades).toBe(1);
  });
  it("ignores zero-amount swaps", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),
      swap(0n, 0n, Q96, 101),
    ] } } });
    const pool = await indexer.Pool.getOrThrow(POOL);
    t.expect(pool.swapCount).toBe(0);
    t.expect(pool.tvlToken).toBe(0n);
    t.expect(pool.tvlQuote).toBe(0n);
    t.expect(await indexer.Swap.getAll()).toHaveLength(0);
    t.expect(await indexer.Candle.getAll()).toHaveLength(0);
  });
  it("aggregates two swaps in one bucket and opens the next bucket at the previous close", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),
      swap(10n ** 18n, -(10n ** 18n), 2n * Q96, 101),
      swap(-(10n ** 18n), 10n ** 18n, Q96, 101),      // same block: same buckets
      swap(10n ** 18n, -(10n ** 18n), 3n * Q96, 200), // 99 minutes later: new m1 bucket
    ] } } });
    const candles = (await indexer.Candle.getAll()).filter((c) => c.interval === "m1").sort((a, b) => a.t - b.t);
    t.expect(candles).toHaveLength(2);
    t.expect(candles[0]!.trades).toBe(2);
    t.expect(candles[0]!.high).toBeCloseTo(4, 9);
    t.expect(candles[0]!.close).toBeCloseTo(1, 9);
    t.expect(candles[1]!.open).toBeCloseTo(1, 9);
    t.expect(candles[1]!.close).toBeCloseTo(9, 9);
  });
  it("ignores swaps on untracked pools", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [swap(1n, -1n, Q96, 5)] } } });
    t.expect(await indexer.Swap.getAll()).toHaveLength(0);
  });
  it("sells on a pool where the token is currency1, excluding the fee from tvl", async (t) => {
    const indexer = createTestIndexer();
    const id = "0x" + "77".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [
      // token price 1 USDG at Initialize: ratio^2 = 1e12 and 10^(6-18) cancel.
      init({ id, currency0: USDG, currency1: OTHER_TOKEN, hooks: ZERO, sqrtPriceX96: Q96 * 1_000_000n }, 100),
      {
        contract: "PoolManager" as const, event: "Swap" as const, srcAddress: POOL_MANAGER,
        block: { number: 101, timestamp: 1_700_000_101 },
        transaction: { hash: TX, from: WALLET },
        // Swapper pays 1 token (amount1 negative) and receives 2 USDG (amount0 positive), fee 1%.
        params: { id, sender: WALLET, amount0: 2_000_000n, amount1: -(10n ** 18n), sqrtPriceX96: Q96 * 2_000_000n, liquidity: 10n ** 18n, tick: 0n, fee: 10000n },
      },
    ] } } });
    const pool = await indexer.Pool.getOrThrow(id);
    const swaps = await indexer.Swap.getAll();
    t.expect(swaps).toHaveLength(1);
    t.expect(swaps[0]!.side).toBe("sell");
    t.expect(swaps[0]!.amountToken).toBeCloseTo(1, 9);
    t.expect(swaps[0]!.amountQuote).toBeCloseTo(2, 9);
    t.expect(swaps[0]!.priceQuote).toBeCloseTo(2, 9); // execution price: 2 USDG / 1 token
    t.expect(pool.priceQuote).toBeCloseTo(0.25, 9);   // post-swap pool price at the chosen sqrtPriceX96
    t.expect(pool.tvlQuote).toBe(-2_000_000n);        // received side: subtracted in full
    // Paid side nets out the 1% fee: 10n**18n * (1_000_000n - 10_000n) / 1_000_000n.
    t.expect(pool.tvlToken).toBe((10n ** 18n * 990_000n) / 1_000_000n);
  });
  it("rounds a non-divisible fee toward zero, in the pool's favor", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),
      {
        contract: "PoolManager" as const, event: "Swap" as const, srcAddress: POOL_MANAGER,
        block: { number: 101, timestamp: 1_700_000_101 },
        transaction: { hash: TX, from: WALLET },
        // Swapper pays 1001 wei of NVDA (quote) and receives 1 wei of AI (token), fee 0.3%.
        params: { id: POOL, sender: WALLET, amount0: 1n, amount1: -1001n, sqrtPriceX96: Q96, liquidity: 10n ** 18n, tick: 0n, fee: 3000n },
      },
    ] } } });
    const pool = await indexer.Pool.getOrThrow(POOL);
    // 1001n * (1_000_000n - 3000n) = 997_997_000n; BigInt division truncates toward zero, so
    // -997_997_000n / 1_000_000n = -997n (not -998n, which floor-toward-negative-infinity
    // division would give). tvlQuote = 0n - (-997n) = 997n exactly.
    t.expect(pool.tvlQuote).toBe(997n);
    t.expect(pool.tvlToken).toBe(-1n); // received side: subtracted in full
  });
});

// A token whose metadata read failed at Initialize used to retry only on
// a second Initialize for the same token, and most tokens never get a second
// pool. Every metadata read fails offline (ENVIO_RPC_URL is blanked, see
// vitest.config.ts), so these exercise the throttled Swap-handler retry path
// directly: metadataRetryAt tracks when the next retry is due, and a swap
// before that time must leave it untouched.
describe("metadata retry throttling", () => {
  function swapAt(timestamp: number, block: number, amount0: bigint, amount1: bigint, sqrtPriceX96: bigint) {
    return {
      contract: "PoolManager" as const, event: "Swap" as const, srcAddress: POOL_MANAGER,
      block: { number: block, timestamp },
      transaction: { hash: TX, from: WALLET },
      params: { id: POOL, sender: WALLET, amount0, amount1, sqrtPriceX96, liquidity: 10n ** 18n, tick: 0n, fee: 3000n },
    };
  }

  it("sets metadataRetryAt to ts + 3600 when Initialize's metadata read fails", async (t) => {
    const indexer = createTestIndexer();
    const initTs = 1_700_000_100; // init({}, 100)'s timestamp: 1_700_000_000 + 100
    await indexer.process({ chains: { 4663: { simulate: [init({}, 100)] } } });
    const token = await indexer.Token.getOrThrow(AI.toLowerCase());
    t.expect(token.metadataLoaded).toBe(false);
    t.expect(token.metadataRetryAt).toBe(initTs + 3600);
  });

  it("leaves metadataRetryAt unchanged for a swap before the retry time", async (t) => {
    const indexer = createTestIndexer();
    const initTs = 1_700_000_100;
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),
      swapAt(initTs + 100, 101, 1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96),
    ] } } });
    const token = await indexer.Token.getOrThrow(AI.toLowerCase());
    t.expect(token.metadataLoaded).toBe(false);
    t.expect(token.metadataRetryAt).toBe(initTs + 3600);
  });

  it("retries and reschedules metadataRetryAt for a swap at or after the retry time", async (t) => {
    const indexer = createTestIndexer();
    const initTs = 1_700_000_100;
    const swapTs = initTs + 3700;
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),
      swapAt(swapTs, 102, 1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96),
    ] } } });
    const token = await indexer.Token.getOrThrow(AI.toLowerCase());
    t.expect(token.metadataLoaded).toBe(false); // still fails offline
    t.expect(token.metadataRetryAt).toBe(swapTs + 3600);
    // The swap itself is still recorded, priced with the fallback decimals.
    const swaps = await indexer.Swap.getAll();
    t.expect(swaps).toHaveLength(1);
  });
});

describe("recomputePrimaryPool", () => {
  it("switches the primary pool to the one with higher USD tvl", async (t) => {
    const indexer = createTestIndexer();
    const usdgPoolId = "0x" + "55".repeat(32);
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),                                                          // AI/NVDA, Doppler hook
      init({ id: usdgPoolId, currency0: AI, currency1: USDG, hooks: ZERO }, 101), // AI/USDG, hookless
    ] } } });
    let token = await indexer.Token.getOrThrow(AI.toLowerCase());
    t.expect(token.poolCount).toBe(2);
    // Both pools have 0 tvl and 0 swaps, so the tiebreak falls to createdAt: the NVDA pool is earliest.
    t.expect(token.primaryPool_id).toBe(POOL);

    await indexer.process({ chains: { 4663: { simulate: [modifyLiquidity(usdgPoolId, 10n ** 18n, 102)] } } });
    token = await indexer.Token.getOrThrow(AI.toLowerCase());
    // USDG is pinned at 1, so the USDG pool now has a nonzero USD tvl while the NVDA pool
    // still has none (no Chainlink price for NVDA exists in this test), and it takes over.
    t.expect(token.primaryPool_id).toBe(usdgPoolId);
    t.expect(token.origin).toBe("Uniswap");

    // Exercises the Swap handler's own poolCount > 1 branch: a swap on the now-non-primary
    // NVDA pool must not disturb the primary pool, since NVDA still has no USD price.
    await indexer.process({ chains: { 4663: { simulate: [swap(1000n * 10n ** 18n, -(10n ** 18n), 2n * Q96, 103)] } } });
    const nvdaPool = await indexer.Pool.getOrThrow(POOL);
    t.expect(nvdaPool.swapCount).toBe(1);
    token = await indexer.Token.getOrThrow(AI.toLowerCase());
    t.expect(token.primaryPool_id).toBe(usdgPoolId);
  });
});

describe("ModifyLiquidity", () => {
  it("orients tvl by currency and leaves exact rounding dust after a full add and remove", async (t) => {
    const indexer = createTestIndexer();
    const id = "0x" + "66".repeat(32);
    // A price far from 1:1 (unlike the default Q96) makes amount0 and amount1 wildly
    // different magnitudes, so this test fails if tokenAmt/quoteAmt were ever swapped in
    // the handler — at Q96 they're both ~1e18 and a swap would go unnoticed.
    const price = Q96 * 1_000_000n;
    await indexer.process({ chains: { 4663: { simulate: [
      init({ id, currency0: USDG, currency1: OTHER_TOKEN, hooks: ZERO, sqrtPriceX96: price }, 100),
    ] } } });
    const { amount0: added0, amount1: added1 } = amountsForLiquidityDelta(price, -887272, 887272, 10n ** 18n);
    t.expect(added0).toBe(1000000000000n);
    t.expect(added1).toBe(1000000000000000000000000n);

    await indexer.process({ chains: { 4663: { simulate: [modifyLiquidity(id, 10n ** 18n, 101)] } } });
    const afterAdd = await indexer.Pool.getOrThrow(id);
    t.expect(afterAdd.tvlToken).toBe(added1); // token is currency1
    t.expect(afterAdd.tvlQuote).toBe(added0); // quote (USDG) is currency0

    const { amount0: removed0, amount1: removed1 } = amountsForLiquidityDelta(price, -887272, 887272, -(10n ** 18n));
    await indexer.process({ chains: { 4663: { simulate: [modifyLiquidity(id, -(10n ** 18n), 102)] } } });
    const afterRemove = await indexer.Pool.getOrThrow(id);
    // Adds round up and removes round down, so a few wei of dust remain instead of exactly 0.
    t.expect(afterRemove.tvlToken).toBe(added1 + removed1);
    t.expect(afterRemove.tvlQuote).toBe(added0 + removed0);
    t.expect(afterRemove.tvlToken).toBe(1n);
    t.expect(afterRemove.tvlQuote).toBe(1n);
  });
});
