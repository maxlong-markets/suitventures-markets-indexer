import { createEffect, S } from "envio";
import {
  createPublicClient,
  http,
  parseAbi,
  hexToString,
  BaseError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  IntegerOutOfRangeError,
  SizeExceedsPaddingSizeError,
} from "viem";
import type { PublicClient } from "viem";

const RPC_URL = process.env.ENVIO_RPC_URL;

// Without ENVIO_RPC_URL, every token silently gets fallback metadata (the
// address-derived symbol, decimals 18) with no warning anywhere. Fail loudly
// at startup instead. VITEST is set by the test runner itself, which
// deliberately blanks this variable offline (see vitest.config.ts): the
// per-call fallback below (an undefined `client`) still exists for that case.
if (!RPC_URL && !process.env.VITEST) {
  throw new Error("ENVIO_RPC_URL is required: token metadata is read over RPC (see README Deploy)");
}

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

// Caps `s` at `max` Unicode code points — not UTF-16 code units. `.slice`
// and `.substring` count code units, so they can cut a surrogate pair (an
// emoji, say) in half and leave a lone surrogate behind. Envio stores
// effect output in a Postgres jsonb column, and Postgres rejects a lone
// surrogate in jsonb text with an encoding error envio's retry logic
// doesn't recognize — so a split surrogate here can fail a batch write and
// halt the indexer. Iterating via Array.from (like `for...of`) walks whole
// code points, so a multi-unit character is always kept or dropped whole.
function capCodePoints(s: string, max: number): string {
  // The first `max` code points always fit within `max * 2` UTF-16 units
  // (each code point is 1 or 2 units), so pre-slicing to that many units
  // before splitting into code points is safe: it can only ever land a cut
  // at or after the `max`-th code point, never inside one of the code
  // points we're keeping, and the `.slice(0, max)` below drops whatever
  // that cut leaves dangling. This keeps capping a long string O(max)
  // instead of O(s.length) — Array.from over the whole string cost ~38 MB
  // and ~32 ms on a 5M-character name.
  return Array.from(s.slice(0, max * 2)).slice(0, max).join("");
}

// True when one of the three concurrent string-ABI calls (symbol, name,
// decimals) threw AbiDecodingDataSizeTooSmallError, IntegerOutOfRangeError,
// or SizeExceedsPaddingSizeError — found anywhere in that error's viem
// `cause` chain — and none of the refusal classes below is also in the
// chain.
//
// A bytes32 symbol() or name() is the common cause: the string ABI misreads
// the fixed 32-byte word as an offset into dynamic data, and that overflow
// or size mismatch throws one of the three classes above (confirmed
// offline below). But it is only one cause, not the definition — a
// malformed decimals() return matches the same classes just as well (e.g.
// a value large enough to overflow the safe-integer check, or fewer than
// 32 bytes of data), even though symbol()/name() decoded fine. That case
// still triggers a bytes32 retry; decimals() is equally malformed under
// the bytes32 ABI, so that retry fails too, and the read ends in the
// uncached fallback via the second catch below — one wasted read round,
// not a correctness problem.
//
// False whenever the chain instead holds a zero-data error
// (AbiDecodingZeroDataError or ContractFunctionZeroDataError — no code at
// the address, or an empty return) or a ContractFunctionRevertedError (the
// call reverted, even if the revert reason itself fails to decode). Those
// calls have no valid return value under any ABI, so retrying with bytes32
// would just repeat the same failure. This check runs before the
// shape-mismatch check below and wins even if a decoding error also
// appears elsewhere in the same cause chain (e.g. while parsing a revert
// reason), since the revert is the real story.
//
// Transport/RPC errors (timeouts, 429s, etc.) match neither set, so a
// transient failure can't be silently misread as "must be a bytes32 token".
//
// Confirmed offline against viem@2.56.3:
// decodeFunctionResult on a real bytes32 payload read with the `string` ABI
// throws IntegerOutOfRangeError (the mis-parsed offset word overflows the
// safe-integer check), not one of the AbiDecoding*Error classes. All
// classes referenced below are the ones this viem version actually exports
// from its root package; PositionOutOfBoundsError and InvalidBytesLengthError
// exist internally but are not exported, so they can't be imported here.
function shouldRetryAsBytes32(err: unknown): boolean {
  const isUnrecoverable =
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof AbiDecodingZeroDataError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof ContractFunctionRevertedError,
    ) !== null;
  if (isUnrecoverable) return false;

  return (
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof AbiDecodingDataSizeTooSmallError ||
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
  const symbol = capCodePoints(clean(rawSymbol), MAX_SYMBOL_LENGTH);
  const name = capCodePoints(clean(rawName), MAX_NAME_LENGTH);
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

  let firstError: unknown;
  try {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20, functionName: "symbol" }),
      client.readContract({ address: addr, abi: ERC20, functionName: "name" }),
      client.readContract({ address: addr, abi: ERC20, functionName: "decimals" }),
    ]);
    return finish(address, symbol, name, decimals);
  } catch (err) {
    firstError = err;
    if (!shouldRetryAsBytes32(err)) {
      return { metadata: { ...fallback(address), ok: false }, error: err };
    }
  }

  try {
    const [symbolBytes, nameBytes, decimals] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "symbol" }),
      client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "name" }),
      client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "decimals" }),
    ]);
    const result = finish(address, hexToString(symbolBytes), hexToString(nameBytes), decimals);
    // The bytes32 read succeeded structurally but failed validation (e.g. a
    // blank cleaned symbol). The original string-decode failure is still
    // the most useful error to surface here, so keep it rather than
    // reporting nothing.
    if (!result.metadata.ok) {
      return { metadata: result.metadata, error: firstError };
    }
    return result;
  } catch (secondError) {
    return {
      metadata: { ...fallback(address), ok: false },
      error: new AggregateError(
        [firstError, secondError],
        "string and bytes32 metadata reads both failed",
      ),
    };
  }
}

/** For logging only: a message that's safe to put in logs or metrics.
 * viem's `BaseError#message` often embeds the RPC URL — and for providers
 * like Alchemy, the URL path carries the API key — while `shortMessage`
 * never does. An `AggregateError` (both the string and bytes32 attempts
 * failed) is described by joining its parts. */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join("; ");
  }
  return String(error);
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
    // Now also called from the Swap handler's throttled metadata retry (see
    // poolManager.ts), not just once per token at Initialize, so a burst of
    // swaps across many still-failing tokens is bounded rather than
    // unlimited.
    rateLimit: { calls: 10, per: "second" },
  },
  async ({ input: address, context }) => {
    const { metadata, error } = await readTokenMetadata(client, address);
    if (!metadata.ok) {
      context.cache = false;
      if (client) {
        context.log.warn(
          `token metadata failed for ${address}: ${error ? describeError(error) : "invalid metadata"}`,
        );
      }
    }
    return metadata;
  },
);
