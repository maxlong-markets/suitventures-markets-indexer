export type Interval = "m1" | "m5" | "m15" | "h1" | "d1";

export const INTERVALS: Interval[] = ["m1", "m5", "m15", "h1", "d1"];

export const INTERVAL_SECONDS: Record<Interval, number> = {
  m1: 60,
  m5: 300,
  m15: 900,
  h1: 3600,
  d1: 86400,
};

export function bucketStart(timestamp: number, interval: Interval): number {
  const s = INTERVAL_SECONDS[interval];
  return Math.floor(timestamp / s) * s;
}

export function candleId(poolId: string, interval: Interval, bucket: number): string {
  return `${poolId}-${interval}-${bucket}`;
}

// Only a plain, trimmed non-negative integer counts as a start block. A bare
// Number(...) conversion would also accept a blank/whitespace string (as 0),
// scientific notation, and a fractional value — none of which is a real
// block height.
const START_BLOCK_RE = /^[0-9]+$/;

function startBlock(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!START_BLOCK_RE.test(trimmed)) return undefined;
  return Number(trimmed);
}

/**
 * 1m and 5m candles are created only from their configured start blocks (spec section 5);
 * unset means disabled, so a forgotten variable cannot explode the backfill.
 */
export function candleWindowAllows(interval: Interval, blockNumber: number): boolean {
  if (interval === "m1") {
    const from = startBlock("ENVIO_CANDLES_1M_START_BLOCK");
    return from !== undefined && blockNumber >= from;
  }
  if (interval === "m5") {
    const from = startBlock("ENVIO_CANDLES_5M_START_BLOCK");
    return from !== undefined && blockNumber >= from;
  }
  return true;
}
