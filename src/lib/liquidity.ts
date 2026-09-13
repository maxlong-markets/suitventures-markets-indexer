import JSBI from "jsbi";
import { TickMath, SqrtPriceMath } from "@uniswap/v3-sdk";

const toJ = (x: bigint) => JSBI.BigInt(x.toString());
const toB = (x: JSBI) => BigInt(x.toString());

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
  if (liquidityDelta === 0n) return { amount0: 0n, amount1: 0n };
  const adding = liquidityDelta > 0n;
  const liquidity = toJ(adding ? liquidityDelta : -liquidityDelta);
  const sqrtCurrent = toJ(sqrtPriceX96);
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
  return { amount0: sign * toB(amount0), amount1: sign * toB(amount1) };
}
