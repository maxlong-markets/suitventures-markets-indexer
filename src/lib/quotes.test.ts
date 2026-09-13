import { describe, it, expect } from "vitest";
import { isQuote, quoteRow, QUOTE_ADDRESSES } from "./quotes";

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
});
