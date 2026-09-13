import { describe, it, expect } from "vitest";
import { shouldSuppressViteWarning } from "./vitest.config";

// FW13: the customLogger built in vitest.config.ts must swallow only Vite's
// "points to missing source files" sourcemap noise (from third-party
// packages like @uniswap/v3-sdk) and forward every other warning untouched.
describe("shouldSuppressViteWarning", () => {
  it("suppresses the missing-sourcemap warning", () => {
    const msg =
      'Sourcemap for "/repo/node_modules/@uniswap/v3-sdk/dist/esm/src/constants.js" points to missing source files';
    expect(shouldSuppressViteWarning(msg)).toBe(true);
  });
  it("forwards every other warning", () => {
    expect(shouldSuppressViteWarning("some other Vite warning entirely")).toBe(false);
    expect(shouldSuppressViteWarning("[vite] deprecated option used")).toBe(false);
  });
});
