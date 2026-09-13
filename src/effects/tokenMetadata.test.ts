import { describe, expect, it } from "vitest";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbi,
  stringToHex,
  HttpRequestError,
} from "viem";
import type { Abi, PublicClient } from "viem";
import { readTokenMetadata } from "./tokenMetadata";

const ADDRESS = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";

// Built at runtime via fromCharCode, so a literal NUL byte never has to
// sit inside this source file.
const NUL = String.fromCharCode(0);

type FieldName = "symbol" | "name" | "decimals";
type RawData = Partial<Record<FieldName, `0x${string}`>>;
type RecordedCall = { abi: Abi; functionName: string };

/**
 * A fake `readContract` that decodes canned ABI-encoded return data with
 * whatever ABI the caller passes in — so the code under test, not the test,
 * decides whether a call is decoded as `string` or `bytes32`. Optionally
 * throws a given error on the first call, to simulate a transport failure.
 */
function makeFakeClient(
  raw: RawData,
  opts: { throwOnce?: unknown } = {},
): { client: Pick<PublicClient, "readContract">; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let hasThrown = false;
  const fakeClient = {
    readContract: async (args: { abi: Abi; functionName: string }) => {
      const { abi, functionName } = args;
      calls.push({ abi, functionName });
      if (opts.throwOnce !== undefined && !hasThrown) {
        hasThrown = true;
        throw opts.throwOnce;
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

  it("(e) treats a bytes32 symbol that decodes blank as a failed read", async () => {
    const { client } = makeFakeClient({
      symbol: encodeBytes32(" "),
      name: encodeBytes32("Maker"),
      decimals: encodeDecimals(18),
    });
    const { metadata } = await readTokenMetadata(client, ADDRESS);
    expect(metadata).toEqual({ ...FALLBACK, ok: false });
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
});
