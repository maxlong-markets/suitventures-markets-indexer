import { describe, it, expect } from "vitest";
import { isDenylisted } from "./denylist";

describe("isDenylisted", () => {
  it("denylists the two crypto pairing assets, cbBTC and TAO", () => {
    expect(isDenylisted("0xcec185eb182c47d1ba1efc84e6959e18cd620be4")).toBe(true); // cbBTC
    expect(isDenylisted("0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67")).toBe(true); // TAO
  });
  it("does not denylist the Robinhood stock tokens BULL, SKHY and WYFI", () => {
    expect(isDenylisted("0xcef9027c7d6985b85f0ba431125073529a947a68")).toBe(false); // BULL
    expect(isDenylisted("0x84cab63bc87912e71ad199ff14a0ba45de68fef8")).toBe(false); // SKHY
    expect(isDenylisted("0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e")).toBe(false); // WYFI
  });
});
