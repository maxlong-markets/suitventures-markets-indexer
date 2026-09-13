import { describe, it, expect, afterEach } from "vitest";
import { bucketStart, candleId, candleWindowAllows, INTERVALS, INTERVAL_SECONDS } from "./candles";

describe("candles", () => {
  const saved = {
    m1: process.env.ENVIO_CANDLES_1M_START_BLOCK,
    m5: process.env.ENVIO_CANDLES_5M_START_BLOCK,
  };
  afterEach(() => {
    if (saved.m1 === undefined) delete process.env.ENVIO_CANDLES_1M_START_BLOCK;
    else process.env.ENVIO_CANDLES_1M_START_BLOCK = saved.m1;
    if (saved.m5 === undefined) delete process.env.ENVIO_CANDLES_5M_START_BLOCK;
    else process.env.ENVIO_CANDLES_5M_START_BLOCK = saved.m5;
  });

  it("has the five intervals in order", () => {
    expect(INTERVALS).toEqual(["m1", "m5", "m15", "h1", "d1"]);
    expect(INTERVAL_SECONDS.d1).toBe(86400);
  });
  it("floors timestamps to the bucket start", () => {
    expect(bucketStart(1757683327, "m1")).toBe(1757683320);
    expect(bucketStart(1757683327, "h1")).toBe(1757682000);
    expect(bucketStart(1757683327, "d1")).toBe(1757635200);
  });
  it("builds ids as pool-interval-bucket", () => {
    expect(candleId("0xabc", "m5", 1757683200)).toBe("0xabc-m5-1757683200");
  });
  it("gates 1m and 5m on their start blocks, never the longer intervals", () => {
    process.env.ENVIO_CANDLES_1M_START_BLOCK = "1000";
    process.env.ENVIO_CANDLES_5M_START_BLOCK = "500";
    expect(candleWindowAllows("m1", 999)).toBe(false);
    expect(candleWindowAllows("m1", 1000)).toBe(true);
    expect(candleWindowAllows("m5", 499)).toBe(false);
    expect(candleWindowAllows("m5", 500)).toBe(true);
    expect(candleWindowAllows("m15", 0)).toBe(true);
    expect(candleWindowAllows("h1", 0)).toBe(true);
    expect(candleWindowAllows("d1", 0)).toBe(true);
  });
  it("disables 1m and 5m when the start block is unset", () => {
    delete process.env.ENVIO_CANDLES_1M_START_BLOCK;
    delete process.env.ENVIO_CANDLES_5M_START_BLOCK;
    expect(candleWindowAllows("m1", 10_000_000)).toBe(false);
    expect(candleWindowAllows("m5", 10_000_000)).toBe(false);
  });

  // FW8: only a plain, trimmed non-negative integer counts as a start block.
  // Number(...) alone would happily accept a blank/whitespace string as 0,
  // scientific notation, and a fractional block number, none of which is a
  // real block height.
  it("disables the interval for a blank/whitespace start block", () => {
    process.env.ENVIO_CANDLES_1M_START_BLOCK = " ";
    expect(candleWindowAllows("m1", 0)).toBe(false);
  });
  it("disables the interval for a negative start block", () => {
    process.env.ENVIO_CANDLES_1M_START_BLOCK = "-1";
    expect(candleWindowAllows("m1", 0)).toBe(false);
  });
  it("disables the interval for a start block in scientific notation", () => {
    process.env.ENVIO_CANDLES_1M_START_BLOCK = "1e3";
    expect(candleWindowAllows("m1", 1000)).toBe(false);
  });
  it("disables the interval for a fractional start block", () => {
    process.env.ENVIO_CANDLES_1M_START_BLOCK = "12.5";
    expect(candleWindowAllows("m1", 13)).toBe(false);
  });
});
