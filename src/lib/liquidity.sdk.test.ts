import { describe, it, expect } from "vitest";
import JSBI from "jsbi";
import { TickMath, SqrtPriceMath } from "@uniswap/v3-sdk";
import {
  getSqrtRatioAtTick,
  getAmount0Delta,
  getAmount1Delta,
  amountsForLiquidityDelta,
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
} from "./liquidity";

// Differential test: this file is the ONLY place in src/ that imports
// @uniswap/v3-sdk / jsbi (see src/lib/liquidity.ts's file header for why they
// were removed from the runtime path). Vitest's own module graph loads them
// fine here — the incompatibility is specific to envio's tsx-based handler
// loader, and this file is never part of the handler import graph.

const toBig = (x: JSBI): bigint => BigInt(x.toString());
const toJSBI = (x: bigint): JSBI => JSBI.BigInt(x.toString());

/** The SDK-based implementation (@uniswap/v3-sdk plus jsbi) that this file checks
 * the native-bigint port in src/lib/liquidity.ts against. */
function referenceAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidityDelta: bigint,
): { amount0: bigint; amount1: bigint } {
  if (liquidityDelta === 0n) return { amount0: 0n, amount1: 0n };
  const adding = liquidityDelta > 0n;
  const liquidity = toJSBI(adding ? liquidityDelta : -liquidityDelta);
  const sqrtCurrent = toJSBI(sqrtPriceX96);
  const sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
  const sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);
  const currentTick = TickMath.getTickAtSqrtRatio(sqrtCurrent);

  let amount0 = JSBI.BigInt(0);
  let amount1 = JSBI.BigInt(0);
  if (currentTick < tickLower) {
    amount0 = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, adding);
  } else if (currentTick < tickUpper) {
    amount0 = SqrtPriceMath.getAmount0Delta(sqrtCurrent, sqrtUpper, liquidity, adding);
    amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtCurrent, liquidity, adding);
  } else {
    amount1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, adding);
  }
  const sign = adding ? 1n : -1n;
  return { amount0: sign * toBig(amount0), amount1: sign * toBig(amount1) };
}

// Fixed seed so a failure reproduces exactly. mulberry32: a small, well-known
// deterministic PRNG (public domain), good enough for test-case generation.
const SEED = 1234567891;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function clampTick(t: number): number {
  return Math.min(MAX_TICK, Math.max(MIN_TICK, t));
}

/** A uniformly random bigint in [0, 2^bits), built from 32-bit chunks. */
function randomBigIntBits(rng: () => number, bits: number): bigint {
  let result = 0n;
  let remaining = bits;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 32);
    const value = Math.floor(rng() * 2 ** chunk);
    result = (result << BigInt(chunk)) | BigInt(value);
    remaining -= chunk;
  }
  return result;
}

/** Random liquidityDelta magnitude in [1, 2^128), randomly signed. */
function randomLiquidityDelta(rng: () => number): bigint {
  let magnitude = randomBigIntBits(rng, 128);
  if (magnitude === 0n) magnitude = 1n;
  return rng() < 0.5 ? magnitude : -magnitude;
}

/** Two distinct ticks in range with lo < hi. `aligned` snaps both to a
 * multiple of tick spacing 8 or 200 (a realistic pool tick spacing). */
function randomTickPair(rng: () => number, aligned: boolean): [number, number] {
  if (aligned) {
    const spacing = rng() < 0.5 ? 8 : 200;
    const maxIdx = Math.floor(MAX_TICK / spacing);
    let i1 = randomInt(rng, -maxIdx, maxIdx);
    let i2 = randomInt(rng, -maxIdx, maxIdx);
    while (i2 === i1) i2 = randomInt(rng, -maxIdx, maxIdx);
    const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
    return [lo * spacing, hi * spacing];
  }
  let a = randomInt(rng, MIN_TICK, MAX_TICK);
  let b = randomInt(rng, MIN_TICK, MAX_TICK);
  while (b === a) b = randomInt(rng, MIN_TICK, MAX_TICK);
  return a < b ? [a, b] : [b, a];
}

/** sqrtPriceX96 at tick `t` plus an offset strictly below the ratio at tick t+1,
 * so the price still corresponds to tick t exactly. The offset is drawn from the
 * whole span (256 random bits, reduced mod the span, so every magnitude of span
 * is reachable) rather than a fixed narrow bit width; `force` pins it to the two
 * extremes (0 and span-1) to exercise the branch boundaries directly. */
function priceNearTick(rng: () => number, t: number, force?: "zero" | "max"): bigint {
  const lo = toBig(TickMath.getSqrtRatioAtTick(t));
  // amountsForLiquidityDelta's valid range is [MIN_SQRT_RATIO, MAX_SQRT_RATIO): at t = MAX_TICK,
  // lo is exactly MAX_SQRT_RATIO, which that range check would reject, so step one wei inside it.
  if (t >= MAX_TICK) return lo - 1n;
  const hi = toBig(TickMath.getSqrtRatioAtTick(t + 1));
  const span = hi - lo;
  if (span <= 0n) return lo;
  const offset = force === "zero" ? 0n : force === "max" ? span - 1n : randomBigIntBits(rng, 256) % span;
  return lo + offset;
}

describe("getSqrtRatioAtTick vs @uniswap/v3-sdk TickMath.getSqrtRatioAtTick", () => {
  it("matches at MIN_TICK, MIN_TICK+1, MAX_TICK-1, MAX_TICK", () => {
    for (const tick of [MIN_TICK, MIN_TICK + 1, MAX_TICK - 1, MAX_TICK]) {
      expect(getSqrtRatioAtTick(tick), `tick=${tick}`).toBe(toBig(TickMath.getSqrtRatioAtTick(tick)));
    }
  });

  it("matches at every tick in [-2048, 2048]", () => {
    for (let tick = -2048; tick <= 2048; tick++) {
      expect(getSqrtRatioAtTick(tick), `tick=${tick}`).toBe(toBig(TickMath.getSqrtRatioAtTick(tick)));
    }
  });

  it("matches at +-(2^k) and +-(2^k +- 1) for k = 0..19, clamped to range", () => {
    for (let k = 0; k <= 19; k++) {
      const p = 2 ** k;
      const candidates = [p, -p, p + 1, p - 1, -(p + 1), -(p - 1)];
      for (const raw of candidates) {
        const tick = clampTick(raw);
        expect(getSqrtRatioAtTick(tick), `k=${k} raw=${raw} tick=${tick}`).toBe(
          toBig(TickMath.getSqrtRatioAtTick(tick)),
        );
      }
    }
  });

  it("matches for 5000 random ticks (seed " + SEED + ")", () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < 5000; i++) {
      const tick = randomInt(rng, MIN_TICK, MAX_TICK);
      expect(getSqrtRatioAtTick(tick), `case ${i}: tick=${tick}`).toBe(toBig(TickMath.getSqrtRatioAtTick(tick)));
    }
  });
});

describe("getAmount0Delta / getAmount1Delta vs SqrtPriceMath", () => {
  it("matches SqrtPriceMath.getAmount0Delta and getAmount1Delta for 1000 random cases", () => {
    const rng = mulberry32(SEED + 2);
    for (let i = 0; i < 1000; i++) {
      const tickA = randomInt(rng, MIN_TICK, MAX_TICK);
      const tickB = randomInt(rng, MIN_TICK, MAX_TICK);
      const sqrtA = getSqrtRatioAtTick(tickA);
      const sqrtB = getSqrtRatioAtTick(tickB);
      const liquidity = randomBigIntBits(rng, 128);
      const roundUp = rng() < 0.5;
      const ctx = `case ${i}: tickA=${tickA} tickB=${tickB} liquidity=${liquidity} roundUp=${roundUp}`;
      expect(getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp), ctx).toBe(
        toBig(SqrtPriceMath.getAmount0Delta(toJSBI(sqrtA), toJSBI(sqrtB), toJSBI(liquidity), roundUp)),
      );
      expect(getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp), ctx).toBe(
        toBig(SqrtPriceMath.getAmount1Delta(toJSBI(sqrtA), toJSBI(sqrtB), toJSBI(liquidity), roundUp)),
      );
    }
  });
});

describe("MIN_SQRT_RATIO / MAX_SQRT_RATIO vs the SDK", () => {
  it("matches TickMath.MIN_SQRT_RATIO and TickMath.MAX_SQRT_RATIO exactly", () => {
    expect(MIN_SQRT_RATIO).toBe(toBig(TickMath.MIN_SQRT_RATIO));
    expect(MAX_SQRT_RATIO).toBe(toBig(TickMath.MAX_SQRT_RATIO));
  });
});

describe("amountsForLiquidityDelta vs the SDK-based reference", () => {
  it("matches referenceAmounts for 5000 random cases (seed " + (SEED + 1) + ")", () => {
    const rng = mulberry32(SEED + 1);
    for (let i = 0; i < 5000; i++) {
      const aligned = i % 2 === 0;
      const [tickLower, tickUpper] = randomTickPair(rng, aligned);
      const anchor = rng() < 0.5 ? tickLower : tickUpper;
      const t = clampTick(anchor + randomInt(rng, -4, 4));
      // Force the offset to the two span extremes periodically to exercise those boundaries directly.
      const force = i % 250 === 0 ? "zero" : i % 250 === 125 ? "max" : undefined;
      const sqrtPriceX96 = priceNearTick(rng, t, force);
      const liquidityDelta = randomLiquidityDelta(rng);

      const ctx = `case ${i}: tickLower=${tickLower} tickUpper=${tickUpper} t=${t} sqrtPriceX96=${sqrtPriceX96} liquidityDelta=${liquidityDelta}`;
      const actual = amountsForLiquidityDelta(sqrtPriceX96, tickLower, tickUpper, liquidityDelta);
      const expected = referenceAmounts(sqrtPriceX96, tickLower, tickUpper, liquidityDelta);
      expect(actual.amount0, ctx).toBe(expected.amount0);
      expect(actual.amount1, ctx).toBe(expected.amount1);
    }
  });

  it("matches referenceAmounts at explicit boundary prices and liquidity magnitudes", () => {
    const tickLower = -1000;
    const tickUpper = 1000;
    const prices: { label: string; sqrtPriceX96: bigint }[] = [
      { label: "at tickLower", sqrtPriceX96: toBig(TickMath.getSqrtRatioAtTick(tickLower)) },
      { label: "at tickUpper", sqrtPriceX96: toBig(TickMath.getSqrtRatioAtTick(tickUpper)) },
      { label: "below range", sqrtPriceX96: toBig(TickMath.getSqrtRatioAtTick(tickLower - 1)) },
      { label: "above range", sqrtPriceX96: toBig(TickMath.getSqrtRatioAtTick(tickUpper + 1)) },
    ];
    const deltas: { label: string; liquidityDelta: bigint }[] = [
      { label: "typical", liquidityDelta: 10n ** 18n },
      { label: "+1", liquidityDelta: 1n },
      { label: "-1", liquidityDelta: -1n },
      { label: "+(2^128-1)", liquidityDelta: (1n << 128n) - 1n },
      { label: "-(2^128-1)", liquidityDelta: -((1n << 128n) - 1n) },
    ];
    for (const { label: priceLabel, sqrtPriceX96 } of prices) {
      for (const { label: deltaLabel, liquidityDelta } of deltas) {
        const ctx = `price=${priceLabel} delta=${deltaLabel}`;
        const actual = amountsForLiquidityDelta(sqrtPriceX96, tickLower, tickUpper, liquidityDelta);
        const expected = referenceAmounts(sqrtPriceX96, tickLower, tickUpper, liquidityDelta);
        expect(actual.amount0, ctx).toBe(expected.amount0);
        expect(actual.amount1, ctx).toBe(expected.amount1);
      }
    }
  });
});

describe("validation", () => {
  it("throws on ticks outside [MIN_TICK, MAX_TICK]", () => {
    // A clearly valid, mid-range price, so a throw here can only come from the tick check
    // (MIN_SQRT_RATIO would leave the price check itself as a possible, ambiguous cause).
    const midPrice = 2n ** 96n;
    expect(() => amountsForLiquidityDelta(midPrice, MIN_TICK - 1, 1000, 10n ** 18n)).toThrow();
    expect(() => amountsForLiquidityDelta(midPrice, -1000, MAX_TICK + 1, 10n ** 18n)).toThrow();
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow();
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow();
  });

  it("throws on a zero price, even with a zero liquidityDelta", () => {
    expect(() => amountsForLiquidityDelta(0n, -1000, 1000, 10n ** 18n)).toThrow();
    expect(() => amountsForLiquidityDelta(0n, -1000, 1000, 0n)).toThrow();
  });

  it("throws on a price at or above MAX_SQRT_RATIO", () => {
    expect(() => amountsForLiquidityDelta(MAX_SQRT_RATIO, -1000, 1000, 10n ** 18n)).toThrow();
    expect(() => amountsForLiquidityDelta(MAX_SQRT_RATIO + 1n, -1000, 1000, 10n ** 18n)).toThrow();
  });

  it("accepts the sqrt-ratio bounds exactly: MIN_SQRT_RATIO and MAX_SQRT_RATIO - 1n, but not one step outside", () => {
    expect(() => amountsForLiquidityDelta(MIN_SQRT_RATIO, -1000, 1000, 10n ** 18n)).not.toThrow();
    expect(() => amountsForLiquidityDelta(MAX_SQRT_RATIO - 1n, -1000, 1000, 10n ** 18n)).not.toThrow();
    expect(() => amountsForLiquidityDelta(MIN_SQRT_RATIO - 1n, -1000, 1000, 10n ** 18n)).toThrow();
    expect(() => amountsForLiquidityDelta(MAX_SQRT_RATIO, -1000, 1000, 10n ** 18n)).toThrow();
  });
});
