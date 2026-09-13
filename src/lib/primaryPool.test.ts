import { describe, it, expect } from "vitest";
import { choosePrimaryPool, type PoolRank } from "./primaryPool";

const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const usd = (q: string) => (q === NVDA ? 224.4 : q === USDG ? 1 : undefined);

function pool(over: Partial<PoolRank>): PoolRank {
  return {
    id: "p", quoteId: NVDA, tvlToken: 0n, tvlQuote: 0n, priceQuote: 0.001,
    tokenDecimals: 18, quoteDecimals: 18, swapCount: 0, createdAt: 100, ...over,
  };
}

describe("choosePrimaryPool", () => {
  it("returns undefined for no pools", () => {
    expect(choosePrimaryPool([], usd)).toBeUndefined();
  });
  it("picks the highest USD TVL across quotes", () => {
    const a = pool({ id: "a", quoteId: NVDA, tvlQuote: 10n * 10n ** 18n, tvlToken: 0n }); // 10 NVDA = $2,244
    const b = pool({ id: "b", quoteId: USDG, quoteDecimals: 6, tvlQuote: 3000n * 10n ** 6n, tvlToken: 0n }); // $3,000
    expect(choosePrimaryPool([a, b], usd)).toBe("b");
  });
  it("counts the token side at the pool price", () => {
    const a = pool({ id: "a", tvlQuote: 1n * 10n ** 18n, tvlToken: 0n }); // 1 NVDA
    const b = pool({ id: "b", tvlQuote: 0n, tvlToken: 5000n * 10n ** 18n, priceQuote: 0.001 }); // 5 NVDA of token
    expect(choosePrimaryPool([a, b], usd)).toBe("b");
  });
  it("falls back to swap count when TVL is unavailable", () => {
    const a = pool({ id: "a", tvlQuote: undefined, tvlToken: undefined, swapCount: 3 });
    const b = pool({ id: "b", tvlQuote: undefined, tvlToken: undefined, swapCount: 9 });
    expect(choosePrimaryPool([a, b], usd)).toBe("b");
  });
  it("falls back to the earliest pool last", () => {
    const a = pool({ id: "a", tvlQuote: undefined, tvlToken: undefined, createdAt: 50 });
    const b = pool({ id: "b", tvlQuote: undefined, tvlToken: undefined, createdAt: 60 });
    expect(choosePrimaryPool([a, b], usd)).toBe("a");
  });
  it("treats a quote without a USD price as zero TVL", () => {
    const a = pool({ id: "a", quoteId: "0xunknown", tvlQuote: 10n ** 24n, swapCount: 1 });
    const b = pool({ id: "b", quoteId: NVDA, tvlQuote: 10n ** 18n, swapCount: 0 });
    expect(choosePrimaryPool([a, b], usd)).toBe("b");
  });
});
