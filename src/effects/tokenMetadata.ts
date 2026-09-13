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
  return Array.from(s).slice(0, max).join("");
}

// True when `err` — or something in its viem `cause` chain — signals that
// symbol()/name() returned data the `string` ABI can't decode, i.e. the
// contract used a bytes32 return instead: worth a bytes32 retry.
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
// Confirmed offline (viem@2.56.3, see task-7-report.md "Fix round 1"):
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
    rateLimit: false,
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
