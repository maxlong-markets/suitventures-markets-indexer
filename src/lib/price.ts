import { formatUnits } from "viem";

const Q96 = 2 ** 96;

/**
 * Token price in quote units from a v4 sqrtPriceX96.
 * price of currency0 in currency1 = (sqrtP / 2^96)^2 * 10^(dec0 - dec1); inverted when the token is currency1.
 * Doubles are fine for display (relative error about 1e-16).
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
  tokenIsCurrency0: boolean,
): number {
  const ratio = Number(sqrtPriceX96) / Q96;
  const price1per0 = ratio * ratio * 10 ** (decimals0 - decimals1);
  return tokenIsCurrency0 ? price1per0 : 1 / price1per0;
}

export function toUnits(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

export function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}
