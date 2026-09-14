import { describe, it, expect } from "vitest";
import { classifyQuoteToken, USDG } from "./quoteClassification.ts";
import quotes from "../config/quotes.json" with { type: "json" };

describe("classifyQuoteToken", () => {
  it("classifies USDG as a quote even though its name doesn't end with Robinhood Token", () => {
    expect(classifyQuoteToken(USDG, "USDG", "Global Dollar")).toBe("quote");
  });

  it("classifies a non-excluded symbol whose name ends with Robinhood Token as a quote", () => {
    expect(classifyQuoteToken("0xaaaa000000000000000000000000000000000a", "AAPL", "Apple • Robinhood Token")).toBe(
      "quote",
    );
  });

  it("classifies an excluded symbol whose name does not end with Robinhood Token as excluded", () => {
    expect(
      classifyQuoteToken("0xbbbb000000000000000000000000000000000b", "cbBTC", "Coinbase Wrapped BTC"),
    ).toBe("excluded");
  });

  it("matches EXCLUDED_SYMBOLS case-insensitively", () => {
    expect(
      classifyQuoteToken("0xcccc000000000000000000000000000000000c", "cbbtc", "Coinbase Wrapped BTC"),
    ).toBe("excluded");
  });

  it("throws, naming the token, when a non-excluded token's name does not end with Robinhood Token", () => {
    expect(() => classifyQuoteToken("0xdddd000000000000000000000000000000000d", "WYFI", "WonderFi")).toThrow(
      "0xdddd000000000000000000000000000000000d",
    );
    expect(() => classifyQuoteToken("0xdddd000000000000000000000000000000000d", "WYFI", "WonderFi")).toThrow(
      "WYFI",
    );
  });

  it("throws, naming the token, when an excluded token's name does end with Robinhood Token", () => {
    expect(() =>
      classifyQuoteToken("0xeeee000000000000000000000000000000000e", "TAO", "Bittensor • Robinhood Token"),
    ).toThrow("0xeeee000000000000000000000000000000000e");
    expect(() =>
      classifyQuoteToken("0xeeee000000000000000000000000000000000e", "TAO", "Bittensor • Robinhood Token"),
    ).toThrow("TAO");
  });
});

// build-quotes.ts decided stock-versus-excluded by symbol alone and ignored
// name(), which is how three real Robinhood stock tokens ended up excluded
// with no error. This checks the committed output still obeys the rule
// classifyQuoteToken enforces at generation time: reads config/quotes.json
// directly rather than running build-quotes.ts, so it makes no network call.
describe("config/quotes.json", () => {
  it("gives every row except USDG a name ending with Robinhood Token", () => {
    const offenders = (quotes as { address: string; symbol: string; name: string }[]).filter(
      (row) => row.address.toLowerCase() !== USDG && !row.name.endsWith("Robinhood Token"),
    );
    expect(offenders).toEqual([]);
  });
});
