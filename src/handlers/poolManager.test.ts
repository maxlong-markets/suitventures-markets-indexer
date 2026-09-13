import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";

// Simulate items type their address-shaped fields (srcAddress, currency0/1, hooks,
// sender, from) as the generated `Address` (`0x${string}`) rather than plain
// `string`. Annotating these constants keeps every value byte-for-byte identical
// while satisfying that at the type level.
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const AI: Address = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG: Address = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
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
});

describe("Swap", () => {
  it("records a buy, updates price, candles and TVL", async (t) => {
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
    t.expect(pool.tvlQuote).toBe(10n ** 18n);
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
});

describe("ModifyLiquidity and Donate", () => {
  it("adds full-range liquidity to TVL and donations on top", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      init({}, 100),
      {
        contract: "PoolManager" as const, event: "ModifyLiquidity" as const, srcAddress: POOL_MANAGER,
        block: { number: 101, timestamp: 1_700_000_101 },
        params: { id: POOL, sender: WALLET, tickLower: -887272n, tickUpper: 887272n, liquidityDelta: 10n ** 18n, salt: "0x" + "00".repeat(32) },
      },
      {
        contract: "PoolManager" as const, event: "Donate" as const, srcAddress: POOL_MANAGER,
        block: { number: 102, timestamp: 1_700_000_102 },
        params: { id: POOL, sender: WALLET, amount0: 5n, amount1: 7n },
      },
    ] } } });
    const pool = await indexer.Pool.getOrThrow(POOL);
    // about 1e18 of each side from the full-range position, plus the donation
    t.expect(Number(pool.tvlToken! - 5n) / 1e18).toBeCloseTo(1, 5);
    t.expect(Number(pool.tvlQuote! - 7n) / 1e18).toBeCloseTo(1, 5);
  });
});
