import { describe, it, expect } from "vitest";
import { originFor } from "./origin";
import { DOPPLER_HOOK, PONS_MEME_HOOK, ZERO_ADDRESS } from "./constants";

describe("originFor", () => {
  it("labels the Doppler hook LONG", () => {
    expect(originFor("0xabc", "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544")).toBe("LONG");
    expect(originFor("0xabc", DOPPLER_HOOK)).toBe("LONG");
  });
  it("labels the Pons hook Pons", () => {
    expect(originFor("0xabc", PONS_MEME_HOOK)).toBe("Pons");
  });
  it("labels no hook Uniswap and unknown hooks Other", () => {
    expect(originFor("0xabc", ZERO_ADDRESS)).toBe("Uniswap");
    expect(originFor("0xabc", "0x1111111111111111111111111111111111111111")).toBe("Other");
  });
  it("lets the curated list override the label", () => {
    // config/curated-pools.json contains this fixture id
    expect(originFor("0x00000000000000000000000000000000000000000000000000000000000000ff", ZERO_ADDRESS)).toBe("SUIT");
  });
});
