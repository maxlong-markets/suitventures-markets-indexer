// Tick / sqrt-price math, ported to native bigint from the installed
// @uniswap/v3-sdk's own compiled output. This module has zero runtime
// dependency on @uniswap/v3-sdk or jsbi: envio's tsx handler loader cannot
// import @uniswap/v3-sdk's ESM build, so it must not appear anywhere in the
// handler import graph.
//
// Ported from (this project's installed @uniswap/v3-sdk, version 3.31.3):
//   node_modules/@uniswap/v3-sdk/dist/esm/src/utils/tickMath.js
//     -> TickMath.getSqrtRatioAtTick, TickMath.MIN_TICK/MAX_TICK/MIN_SQRT_RATIO/MAX_SQRT_RATIO
//   node_modules/@uniswap/v3-sdk/dist/esm/src/utils/sqrtPriceMath.js
//     -> SqrtPriceMath.getAmount0Delta, SqrtPriceMath.getAmount1Delta
//   node_modules/@uniswap/v3-sdk/dist/esm/src/utils/fullMath.js
//     -> FullMath.mulDivRoundingUp
//
// TickMath.getTickAtSqrtRatio is intentionally NOT ported (it's the most
// complex piece: a most-significant-bit scan plus a log2 approximation).
// amountsForLiquidityDelta below branches on sqrt-price comparisons instead
// of computing the current tick — see the comment at that call site for why
// the two are equivalent.
//
// A differential test (src/lib/liquidity.sdk.test.ts) checks every function
// below against the real @uniswap/v3-sdk (imported only in that test file)
// across thousands of generated cases, so a transcription slip in the magic
// constants below would fail loudly rather than silently.

/** The minimum tick that can be used on any pool. */
export const MIN_TICK = -887272;
/** The maximum tick that can be used on any pool. */
export const MAX_TICK = -MIN_TICK;
/** The sqrt ratio corresponding to the minimum tick that could be used on any pool. */
export const MIN_SQRT_RATIO = 4295128739n;
/** The sqrt ratio corresponding to the maximum tick that could be used on any pool. */
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q32 = 1n << 32n;
const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** (val * mulBy) >> 128, matching JSBI.signedRightShift for this function's always
 * non-negative operands (arithmetic and logical right shift agree when non-negative). */
function mulShift(val: bigint, mulBy: bigint): bigint {
  return (val * mulBy) >> 128n;
}

/**
 * Returns the sqrt ratio as a Q64.96 for the given tick: sqrt(1.0001)^tick.
 * Ported bit-for-bit from TickMath.getSqrtRatioAtTick (see file header). The 20 magic
 * hex constants below are copied verbatim from that file's source, not retyped from memory.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick out of range [${MIN_TICK}, ${MAX_TICK}]: ${tick}`);
  }
  const absTick = tick < 0 ? -tick : tick;

  let ratio =
    (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, 0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, 0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, 0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // back to Q96
  return ratio % Q32 > 0n ? ratio / Q32 + 1n : ratio / Q32;
}

/** Ported from FullMath.mulDivRoundingUp. Every call site below passes non-negative
 * operands, so native truncating BigInt division matches JSBI.divide's behavior. */
function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  const result = product / denominator;
  return product % denominator !== 0n ? result + 1n : result;
}

/** Ported from SqrtPriceMath.getAmount0Delta. */
export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [sqrtRatioAX96, sqrtRatioBX96] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  return roundUp
    ? mulDivRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), 1n, sqrtRatioAX96)
    : (numerator1 * numerator2) / sqrtRatioBX96 / sqrtRatioAX96;
}

/** Ported from SqrtPriceMath.getAmount1Delta. */
export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [sqrtRatioAX96, sqrtRatioBX96] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  return roundUp
    ? mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96)
    : (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96;
}

/**
 * Raw token amounts a liquidity change moves into (+) or out of (-) a pool.
 * Same piecewise rule as Uniswap's Pool.modifyLiquidity: only the part of the
 * range around the current price holds both currencies. Price does not move
 * between swaps, so the pool's stored sqrtPriceX96 is the right price here.
 */
export function amountsForLiquidityDelta(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidityDelta: bigint,
): { amount0: bigint; amount1: bigint } {
  // Validated unconditionally, before the zero-liquidityDelta shortcut below: a caller
  // passing a zero delta alongside a nonsensical price or tick range is a bug worth
  // surfacing immediately, not a no-op to silently accept.
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error(`sqrtPriceX96 out of range [${MIN_SQRT_RATIO}, ${MAX_SQRT_RATIO}): ${sqrtPriceX96}`);
  }
  if (!Number.isInteger(tickLower) || tickLower < MIN_TICK || tickLower > MAX_TICK) {
    throw new Error(`tickLower out of range [${MIN_TICK}, ${MAX_TICK}]: ${tickLower}`);
  }
  if (!Number.isInteger(tickUpper) || tickUpper < MIN_TICK || tickUpper > MAX_TICK) {
    throw new Error(`tickUpper out of range [${MIN_TICK}, ${MAX_TICK}]: ${tickUpper}`);
  }
  if (tickLower >= tickUpper) {
    throw new Error(`tickLower must be less than tickUpper: ${tickLower} >= ${tickUpper}`);
  }
  if (liquidityDelta === 0n) return { amount0: 0n, amount1: 0n };
  const adding = liquidityDelta > 0n;
  const liquidity = adding ? liquidityDelta : -liquidityDelta;
  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);

  let amount0 = 0n;
  let amount1 = 0n;
  // Equivalent to comparing the pool's current tick (TickMath.getTickAtSqrtRatio(sqrtPriceX96))
  // against tickLower/tickUpper: getSqrtRatioAtTick is strictly increasing in tick, and
  // getTickAtSqrtRatio(sqrtP) is defined as its floor-inverse —
  //   getSqrtRatioAtTick(getTickAtSqrtRatio(sqrtP)) <= sqrtP < getSqrtRatioAtTick(getTickAtSqrtRatio(sqrtP) + 1)
  // — so getTickAtSqrtRatio(sqrtP) < tick  <=>  sqrtP < getSqrtRatioAtTick(tick). Comparing sqrt
  // prices directly gives the identical branch without porting getTickAtSqrtRatio at all.
  if (sqrtPriceX96 < sqrtLower) {
    amount0 = getAmount0Delta(sqrtLower, sqrtUpper, liquidity, adding);
  } else if (sqrtPriceX96 < sqrtUpper) {
    amount0 = getAmount0Delta(sqrtPriceX96, sqrtUpper, liquidity, adding);
    amount1 = getAmount1Delta(sqrtLower, sqrtPriceX96, liquidity, adding);
  } else {
    amount1 = getAmount1Delta(sqrtLower, sqrtUpper, liquidity, adding);
  }
  const sign = adding ? 1n : -1n;
  return { amount0: sign * amount0, amount1: sign * amount1 };
}
