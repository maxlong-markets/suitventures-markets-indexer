import { createEffect, S } from "envio";
import {
  createPublicClient,
  http,
  parseAbi,
  hexToString,
  BaseError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  IntegerOutOfRangeError,
  SizeExceedsPaddingSizeError,
} from "viem";
import type { PublicClient } from "viem";

const RPC_URL = process.env.ENVIO_RPC_URL;

const client = RPC_URL
  ? createPublicClient({ transport: http(RPC_URL, { batch: true }) })
  : undefined;

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const ERC20_BYTES = parseAbi([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
  "function decimals() view returns (uint8)",
]);

const MAX_SYMBOL_LENGTH = 32;
const MAX_NAME_LENGTH = 128;

export type TokenMetadata = {
  symbol: string;
  name: string;
  decimals: number;
  ok: boolean;
};

function fallback(address: string): Omit<TokenMetadata, "ok"> {
  return { symbol: address.slice(0, 6), name: address, decimals: 18 };
}

// bytes32 names are padded with NUL bytes, and some string returns carry
// stray NULs too; strip both, then trim, before capping length or
// validating. Applies to both the string and bytes32 decode paths.
function clean(s: string): string {
  return s.replace(/\x00/g, "").trim();
}

// True when `err` — or something in its viem `cause` chain — is an ABI
// decoding error. That's the signal that the contract returned bytes32 from
// symbol()/name() instead of the standard string, so retrying with the
// bytes32 ABI is worth it. Transport/RPC errors (timeouts, 429s, etc.) never
// match this, so a transient failure can't be silently misread as "must be
// a bytes32 token".
//
// Confirmed offline (viem@2.56.3, see task-7-report.md "Fix round 1"):
// decodeFunctionResult on a real bytes32 payload read with the `string` ABI
// throws IntegerOutOfRangeError (the mis-parsed offset word overflows the
// safe-integer check), not one of the AbiDecoding*Error classes. All four
// classes below are the ones this viem version actually exports from its
// root package; PositionOutOfBoundsError and InvalidBytesLengthError exist
// internally but are not exported, so they can't be imported here.
function isAbiDecodingError(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof AbiDecodingDataSizeTooSmallError ||
        e instanceof AbiDecodingZeroDataError ||
        e instanceof IntegerOutOfRangeError ||
        e instanceof SizeExceedsPaddingSizeError,
    ) !== null
  );
}

// Cleans and bounds-checks a decoded triple. Returns undefined (a failed
// read) for a blank symbol/name after cleaning, or a decimals value outside
// uint8's real range — viem decodes whatever 32-byte word is there with no
// 8-bit check of its own, so a hostile `decimals()` has to be rejected here.
function validate(
  rawSymbol: string,
  rawName: string,
  rawDecimals: number,
): { symbol: string; name: string; decimals: number } | undefined {
  const symbol = clean(rawSymbol).slice(0, MAX_SYMBOL_LENGTH);
  const name = clean(rawName).slice(0, MAX_NAME_LENGTH);
  if (!symbol || !name) return undefined;
  if (!Number.isInteger(rawDecimals) || rawDecimals < 0 || rawDecimals > 255) {
    return undefined;
  }
  return { symbol, name, decimals: rawDecimals };
}

function finish(
  address: string,
  rawSymbol: string,
  rawName: string,
  rawDecimals: number,
): { metadata: TokenMetadata; error?: unknown } {
  const validated = validate(rawSymbol, rawName, rawDecimals);
  if (!validated) {
    return { metadata: { ...fallback(address), ok: false } };
  }
  return { metadata: { ...validated, ok: true } };
}

/**
 * Reads symbol/name/decimals for the ERC-20 at `address`. Pure apart from
 * the `client` calls, and never throws: every failed path — no client, a
 * transport/RPC error, an exhausted bytes32 retry, or a validation
 * rejection — resolves to the synthetic fallback shape with `ok: false`
 * (and `error` set when a call actually threw); a successful read resolves
 * with the real values and `ok: true`.
 */
export async function readTokenMetadata(
  client: Pick<PublicClient, "readContract"> | undefined,
  address: string,
): Promise<{ metadata: TokenMetadata; error?: unknown }> {
  if (!client) {
    return { metadata: { ...fallback(address), ok: false } };
  }
  const addr = address as `0x${string}`;

  try {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20, functionName: "symbol" }),
      client.readContract({ address: addr, abi: ERC20, functionName: "name" }),
      client.readContract({ address: addr, abi: ERC20, functionName: "decimals" }),
    ]);
    return finish(address, symbol, name, decimals);
  } catch (firstError) {
    if (!isAbiDecodingError(firstError)) {
      return { metadata: { ...fallback(address), ok: false }, error: firstError };
    }
  }

  try {
    const [symbolBytes, nameBytes, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "symbol" }),
      client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "name" }),
      client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "decimals" }),
    ]);
    return finish(address, hexToString(symbolBytes), hexToString(nameBytes), decimals);
  } catch (secondError) {
    return { metadata: { ...fallback(address), ok: false }, error: secondError };
  }
}

/** Name, symbol and decimals of an ERC-20. Successful reads are cached
 * forever per address; fallback results (RPC unset, a transport failure, or
 * a rejected/garbage read) are never cached, so a rate-limit burst or a
 * deploy missing ENVIO_RPC_URL can't freeze bad data in place. */
export const getTokenMetadata = createEffect(
  {
    name: "getTokenMetadata",
    input: S.string,
    output: { symbol: S.string, name: S.string, decimals: S.number, ok: S.boolean },
    cache: true,
    rateLimit: false,
  },
  async ({ input: address, context }) => {
    const { metadata, error } = await readTokenMetadata(client, address);
    if (!metadata.ok) {
      context.cache = false;
      if (client) {
        context.log.warn(
          `token metadata failed for ${address}: ${error ? String(error) : "invalid metadata"}`,
        );
      }
    }
    return metadata;
  },
);
