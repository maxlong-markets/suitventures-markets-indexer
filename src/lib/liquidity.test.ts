import { describe, it, expect } from "vitest";
import { amountsForLiquidityDelta } from "./liquidity";

const Q96 = 2n ** 96n;
const L = 10n ** 18n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

function rel(a: bigint, b: number): number {
  return Math.abs(Number(a) - b) / Math.abs(b);
}

describe("amountsForLiquidityDelta", () => {
  it("full range at price 1 puts about L on both sides", () => {
    const { amount0, amount1 } = amountsForLiquidityDelta(Q96, MIN_TICK, MAX_TICK, L);
    expect(rel(amount0, 1e18)).toBeLessThan(1e-6);
    expect(rel(amount1, 1e18)).toBeLessThan(1e-6);
  });
  it("symmetric +-100 tick range at tick 0", () => {
    // sqrt(1.0001^100) = 1.00501227; amount = L * (1 - 1/1.00501227) = 0.00498727 L on each side
    const { amount0, amount1 } = amountsForLiquidityDelta(Q96, -100, 100, L);
    expect(rel(amount0, 0.00498727e18)).toBeLessThan(1e-5);
    expect(rel(amount1, 0.00498727e18)).toBeLessThan(1e-5);
  });
  it("range entirely above the price is all currency0", () => {
    const { amount0, amount1 } = amountsForLiquidityDelta(Q96, 100, 200, L);
    expect(amount0 > 0n).toBe(true);
    expect(amount1).toBe(0n);
  });
  it("range entirely below the price is all currency1", () => {
    const { amount0, amount1 } = amountsForLiquidityDelta(Q96, -200, -100, L);
    expect(amount0).toBe(0n);
    expect(amount1 > 0n).toBe(true);
  });
  it("negative delta returns negative amounts (removal)", () => {
    const { amount0, amount1 } = amountsForLiquidityDelta(Q96, -100, 100, -L);
    expect(amount0 < 0n).toBe(true);
    expect(amount1 < 0n).toBe(true);
  });
});
