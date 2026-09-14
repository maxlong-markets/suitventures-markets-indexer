import { describe, it, expect } from "vitest";
import { isQuote, quoteRow, QUOTE_ADDRESSES, quoteForFeed, validateQuotes, type QuoteRow } from "./quotes";

describe("quotes", () => {
  it("recognises USDG and NVDA regardless of case", () => {
    expect(isQuote("0x5fc5360d0400a0fd4f2af552add042d716f1d168")).toBe(true);
    expect(isQuote("0xD0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC")).toBe(true);
  });
  it("rejects a memecoin address", () => {
    expect(isQuote("0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18")).toBe(false);
  });
  it("returns the row with decimals", () => {
    expect(quoteRow("0x5fc5360d0400a0fd4f2af552add042d716f1d168")?.decimals).toBe(6);
    expect(quoteRow("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec")?.symbol).toBe("NVDA");
  });
  it("exposes lowercase addresses", () => {
    for (const a of QUOTE_ADDRESSES) expect(a).toBe(a.toLowerCase());
  });
  it("has at least the five seed quotes", () => {
    expect(QUOTE_ADDRESSES.length).toBeGreaterThanOrEqual(5);
  });
  it("maps a Chainlink proxy or aggregator back to its quote", () => {
    const nvda = quoteRow("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec")!;
    expect(nvda.chainlinkProxy).toBeTruthy();
    expect(nvda.chainlinkAggregator).toBeTruthy();
    expect(nvda.chainlinkDecimals).toBe(8);
    expect(quoteForFeed(nvda.chainlinkProxy!.toUpperCase())?.symbol).toBe("NVDA");
    expect(quoteForFeed(nvda.chainlinkAggregator!)?.symbol).toBe("NVDA");
    expect(quoteForFeed("0x1111111111111111111111111111111111111111")).toBeUndefined();
  });
  it("allowlists the Robinhood stock tokens WYFI, SKHY and BULL with 18 decimals and no Chainlink feed yet", () => {
    for (const address of [
      "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e", // WYFI
      "0x84cab63bc87912e71ad199ff14a0ba45de68fef8", // SKHY
      "0xcef9027c7d6985b85f0ba431125073529a947a68", // BULL
    ]) {
      expect(QUOTE_ADDRESSES).toContain(address);
      const row = quoteRow(address)!;
      expect(row.address).toBe(address);
      expect(row.decimals).toBe(18);
      expect(row.chainlinkProxy).toBeNull();
    }
  });
});

// FW10: a malformed config/quotes.json (a duplicate address, a bad decimals
// value, a one-sided Chainlink pairing, or a missing/misconfigured USDG row)
// must fail the indexer at startup, not silently produce wrong prices or a
// broken lookup later. validateQuotes is the pure function the module-level
// call runs against the real file; these tests exercise it directly with
// fabricated rows instead of editing the real config.
describe("validateQuotes", () => {
  const USDG_ROW: QuoteRow = {
    address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    symbol: "USDG", name: "Global Dollar", decimals: 6,
    chainlinkProxy: null, chainlinkAggregator: null, chainlinkDecimals: null,
  };
  const STOCK_ROW: QuoteRow = {
    address: "0x0000000000000000000000000000000000000001",
    symbol: "AAPL", name: "Apple", decimals: 18,
    chainlinkProxy: "0xaaaa000000000000000000000000000000000a",
    chainlinkAggregator: "0xbbbb000000000000000000000000000000000b",
    chainlinkDecimals: 8,
  };

  it("accepts a well-formed allowlist", () => {
    expect(() => validateQuotes([USDG_ROW, STOCK_ROW])).not.toThrow();
  });
  it("throws on a duplicate address", () => {
    expect(() => validateQuotes([USDG_ROW, STOCK_ROW, { ...STOCK_ROW, symbol: "DUPE" }])).toThrow();
  });
  it("throws when decimals is not an integer from 0 to 255", () => {
    expect(() => validateQuotes([USDG_ROW, { ...STOCK_ROW, decimals: 256 }])).toThrow();
    expect(() => validateQuotes([USDG_ROW, { ...STOCK_ROW, decimals: -1 }])).toThrow();
    expect(() => validateQuotes([USDG_ROW, { ...STOCK_ROW, decimals: 1.5 }])).toThrow();
  });
  it("throws when chainlinkProxy is set without chainlinkAggregator", () => {
    expect(() => validateQuotes([USDG_ROW, { ...STOCK_ROW, chainlinkAggregator: null }])).toThrow();
  });
  it("throws when chainlinkAggregator is set without chainlinkProxy", () => {
    expect(() => validateQuotes([USDG_ROW, { ...STOCK_ROW, chainlinkProxy: null }])).toThrow();
  });
  it("throws when the USDG row is missing", () => {
    expect(() => validateQuotes([STOCK_ROW])).toThrow();
  });
  it("throws when USDG's decimals aren't 6", () => {
    expect(() => validateQuotes([{ ...USDG_ROW, decimals: 18 }, STOCK_ROW])).toThrow();
  });
});
