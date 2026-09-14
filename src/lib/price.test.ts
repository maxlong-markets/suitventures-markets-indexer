import { describe, it, expect } from "vitest";
import { priceFromSqrtPriceX96, toUnits, absBig } from "./price";

const Q96 = 2n ** 96n;

describe("priceFromSqrtPriceX96", () => {
  it("is 1 at sqrtP = 2^96 with equal decimals", () => {
    expect(priceFromSqrtPriceX96(Q96, 18, 18, true)).toBeCloseTo(1, 12);
    expect(priceFromSqrtPriceX96(Q96, 18, 18, false)).toBeCloseTo(1, 12);
  });
  it("adjusts for decimals (18-dec token vs 6-dec USDG)", () => {
    // raw ratio 1 wei/wei: 1e18 wei of token = 1e18 wei of USDG = 1e12 USDG
    expect(priceFromSqrtPriceX96(Q96, 18, 6, true)).toBeCloseTo(1e12, 0);
  });
  it("inverts when the token is currency1", () => {
    const sqrtP = 2n * Q96; // price1per0 = 4
    expect(priceFromSqrtPriceX96(sqrtP, 18, 18, true)).toBeCloseTo(4, 9);
    expect(priceFromSqrtPriceX96(sqrtP, 18, 18, false)).toBeCloseTo(0.25, 9);
  });
  it("matches the AI/NVDA pool within 0.1%", () => {
    // AI is currency0, NVDA currency1, both 18 decimals; DexScreener priceNative 0.0008658
    const sqrtP = 2331300000000000000000000000n;
    const p = priceFromSqrtPriceX96(sqrtP, 18, 18, true);
    expect(Math.abs(p - 0.0008658) / 0.0008658).toBeLessThan(0.001);
  });
});

describe("toUnits / absBig", () => {
  it("formats raw amounts", () => {
    expect(toUnits(1500000n, 6)).toBe(1.5);
    expect(toUnits(2n * 10n ** 18n, 18)).toBe(2);
  });
  it("abs on bigint", () => {
    expect(absBig(-5n)).toBe(5n);
    expect(absBig(5n)).toBe(5n);
  });
});
