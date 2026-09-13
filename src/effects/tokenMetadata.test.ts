import { describe, expect, it } from "vitest";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbi,
  stringToHex,
  BaseError,
  HttpRequestError,
  IntegerOutOfRangeError,
} from "viem";
import type { Abi, PublicClient } from "viem";
import { describeError, readTokenMetadata } from "./tokenMetadata";

const ADDRESS = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";

// Built at runtime via fromCharCode/fromCodePoint, so neither a literal NUL
// byte nor a literal surrogate escape ever has to sit inside this file's
// source text (see the "Fix round 1" tooling note in the task report: a
// `\u`-style escape typed into a tool-call parameter lands as a raw
// character on disk instead of staying source text).
const NUL = String.fromCharCode(0);
const EMOJI = String.fromCodePoint(0x1f600);

type FieldName = "symbol" | "name" | "decimals";
type RawData = Partial<Record<FieldName, `0x${string}`>>;
type RecordedCall = { abi: Abi; functionName: string };

// Structural check (not reference equality) so this works regardless of
// which module's `parseAbi([...])` call produced the ABI array the
// production code actually passed to `readContract`.
function abiReturnsBytes32(abi: Abi, functionName: string): boolean {
  const item = abi.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "function" &&
      "name" in entry &&
      entry.name === functionName,
  ) as { outputs?: readonly { type?: string }[] } | undefined;
  return item?.outputs?.[0]?.type === "bytes32";
}

function usedBytes32Abi(calls: RecordedCall[]): boolean {
  return calls.some((call) => abiReturnsBytes32(call.abi, call.functionName));
}

/**
 * A fake `readContract` that decodes canned ABI-encoded return data with
 * whatever ABI the caller passes in — so the code under test, not the test,
 * decides whether a call is decoded as `string` or `bytes32`.
 *
 * `throwOnce` throws a given error on the very first call, to simulate a
 * transport failure on the initial (string-ABI) attempt. `throwOnBytes32`
 * throws a given error on the first call that uses a bytes32-shaped ABI, to
 * simulate a transport failure on the retry attempt instead.
 */
function makeFakeClient(
  raw: RawData,
  opts: { throwOnce?: unknown; throwOnBytes32?: unknown } = {},
): { client: Pick<PublicClient, "readContract">; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let hasThrownOnce = false;
  let hasThrownBytes32 = false;
  const fakeClient = {
    readContract: async (args: { abi: Abi; functionName: string }) => {
      const { abi, functionName } = args;
      calls.push({ abi, functionName });
      if (opts.throwOnce !== undefined && !hasThrownOnce) {
        hasThrownOnce = true;
        throw opts.throwOnce;
      }
      if (
        opts.throwOnBytes32 !== undefined &&
        !hasThrownBytes32 &&
        abiReturnsBytes32(abi, functionName)
      ) {
        hasThrownBytes32 = true;
        throw opts.throwOnBytes32;
      }
      const data = raw[functionName as FieldName];
      if (data === undefined) {
        throw new Error(`test setup: no canned data for ${functionName}`);
      }
      return decodeFunctionResult({ abi, functionName, data } as Parameters<
        typeof decodeFunctionResult
      >[0]);
    },
  };
  return { client: fakeClient as unknown as Pick<PublicClient, "readContract">, calls };
}

function encodeString(value: string): `0x${string}` {
  return encodeAbiParameters([{ type: "string" }], [value]);
}
function encodeBytes32(value: string): `0x${string}` {
  return encodeAbiParameters([{ type: "bytes32" }], [stringToHex(value, { size: 32 })]);
}
function encodeDecimals(value: number): `0x${string}` {
  return encodeAbiParameters([{ type: "uint8" }], [value]);
}
function encodeOutOfRangeDecimals(value: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }], [value]);
}

const FALLBACK = { symbol: ADDRESS.slice(0, 6), name: ADDRESS, decimals: 18 };

// A code-point-safe cap must never leave a lone surrogate behind. Iterating
// with `for...of` walks whole code points, so a *paired* surrogate (a
// normal emoji) comes back as one multi-unit character whose `codePointAt`
// is its real (non-surrogate) value — only a genuine lone/unpaired
// surrogate would report a codePointAt in the surrogate range.
function assertNoUnpairedSurrogate(s: string): void {
  for (const ch of s) {
    const codePoint = ch.codePointAt(0) ?? 0;
    const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
    expect(isSurrogate).toBe(false);
  }
}

describe("readTokenMetadata", () => {
  it("(a) falls back to the synthetic shape when the client is undefined", async () => {
    const { metadata, error } = await readTokenMetadata(undefined, ADDRESS);
    expect(metadata).toEqual({ ...FALLBACK, ok: false });
    expect(error).toBeUndefined();
  });

  it("(b) decodes standard string returns", async () => {
    const { client, calls } = makeFakeClient({
      symbol: encodeString("AI"),
      name: encodeString("AI Token"),
      decimals: encodeDecimals(18),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ symbol: "AI", name: "AI Token", decimals: 18, ok: true });
    expect(usedBytes32Abi(calls)).toBe(false);
  });

  it("(c) retries with the bytes32 ABI and decodes MKR-style returns", async () => {
    const { client, calls } = makeFakeClient({
      symbol: encodeBytes32("MKR"),
      name: encodeBytes32("Maker"),
      decimals: encodeDecimals(18),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ symbol: "MKR", name: "Maker", decimals: 18, ok: true });
    expect(usedBytes32Abi(calls)).toBe(true);
  });

  it("(d) falls back on a transport error without ever trying the bytes32 ABI", async () => {
    const { client, calls } = makeFakeClient(
      {
        symbol: encodeString("AI"),
        name: encodeString("AI Token"),
        decimals: encodeDecimals(18),
      },
      { throwOnce: new HttpRequestError({ url: "https://rpc.example" }) },
    );
    const { metadata, error } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ ...FALLBACK, ok: false });
    expect(error).toBeInstanceOf(HttpRequestError);
    expect(usedBytes32Abi(calls)).toBe(false);
  });

  it("(e) treats a bytes32 symbol that decodes blank as a failed read, and keeps the first decode error", async () => {
    const { client } = makeFakeClient({
      symbol: encodeBytes32(" "),
      name: encodeBytes32("Maker"),
      decimals: encodeDecimals(18),
    });
    const { metadata, error } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ ...FALLBACK, ok: false });
    // The bytes32 read decoded fine structurally; validation is what
    // failed. The error surfaced should still be the original string-ABI
    // decode failure that triggered the retry in the first place.
    expect(error).toBeInstanceOf(BaseError);
    if (!(error instanceof BaseError)) throw new Error("expected a viem BaseError");
    expect(error.walk((e) => e instanceof IntegerOutOfRangeError)).not.toBeNull();
  });

  it("(f) treats an out-of-range decimals value as a failed read", async () => {
    const { client } = makeFakeClient({
      symbol: encodeString("AI"),
      name: encodeString("AI Token"),
      decimals: encodeOutOfRangeDecimals(1000n),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ ...FALLBACK, ok: false });
  });

  it("(g) caps an overlong name at 128 characters", async () => {
    const longName = "A".repeat(200);
    const { client } = makeFakeClient({
      symbol: encodeString("AI"),
      name: encodeString(longName),
      decimals: encodeDecimals(18),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata.ok).toBe(true);
    expect(metadata.name).toBe(longName.slice(0, 128));
    expect(metadata.name.length).toBe(128);
  });

  it("(h) cleans a symbol with surrounding spaces and NUL padding", async () => {
    const paddedSymbol = `  AI${NUL}${NUL}  `;
    const { client } = makeFakeClient({
      symbol: encodeString(paddedSymbol),
      name: encodeString("AI Token"),
      decimals: encodeDecimals(18),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ symbol: "AI", name: "AI Token", decimals: 18, ok: true });
  });

  it("(i) reports an AggregateError holding both errors when the bytes32 retry also fails", async () => {
    const transportError = new HttpRequestError({ url: "https://rpc.example" });
    const { client, calls } = makeFakeClient(
      {
        symbol: encodeBytes32("MKR"),
        name: encodeBytes32("Maker"),
        decimals: encodeDecimals(18),
      },
      { throwOnBytes32: transportError },
    );
    const { metadata, error } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ ...FALLBACK, ok: false });
    // The retry really was attempted (that's how the second error happened).
    expect(usedBytes32Abi(calls)).toBe(true);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("expected an AggregateError");
    expect(error.errors).toHaveLength(2);
    expect(error.errors).toContain(transportError);
    const hasFirstDecodeError = error.errors.some(
      (e) => e instanceof BaseError && e.walk((x) => x instanceof IntegerOutOfRangeError) !== null,
    );
    expect(hasFirstDecodeError).toBe(true);
  });

  it("(j) keeps a symbol that exactly fits the 32-code-point cap, emoji included", async () => {
    const symbolInput = "A".repeat(31) + EMOJI; // 32 code points total
    const { client } = makeFakeClient({
      symbol: encodeString(symbolInput),
      name: encodeString("AI Token"),
      decimals: encodeDecimals(18),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata.ok).toBe(true);
    expect(metadata.symbol).toBe(symbolInput);
    expect(Array.from(metadata.symbol).length).toBeLessThanOrEqual(32);
    assertNoUnpairedSurrogate(metadata.symbol);
  });

  it("(j) drops a trailing emoji whole, rather than splitting it, once over the cap", async () => {
    const symbolInput = "A".repeat(32) + EMOJI; // 33 code points, one over the cap
    const { client } = makeFakeClient({
      symbol: encodeString(symbolInput),
      name: encodeString("AI Token"),
      decimals: encodeDecimals(18),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata.ok).toBe(true);
    expect(metadata.symbol).toBe("A".repeat(32));
    expect(Array.from(metadata.symbol).length).toBeLessThanOrEqual(32);
    assertNoUnpairedSurrogate(metadata.symbol);
  });

  it("(k) never retries with the bytes32 ABI after a zero-data error", async () => {
    const { client, calls } = makeFakeClient({
      symbol: "0x", // empty return data: decodeFunctionResult throws AbiDecodingZeroDataError
      name: encodeString("AI Token"),
      decimals: encodeDecimals(18),
    });
    const { metadata, error } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ ...FALLBACK, ok: false });
    expect(error).toBeInstanceOf(BaseError);
    expect(usedBytes32Abi(calls)).toBe(false);
  });

  it("(l) describeError never leaks the RPC URL", () => {
    const message = describeError(
      new HttpRequestError({ url: "https://rpc.example/v2/SECRETKEY" }),
    );
    expect(message).not.toContain("SECRETKEY");
  });
});
