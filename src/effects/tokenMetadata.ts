import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi, hexToString } from "viem";

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

function fallback(address: string) {
  return { symbol: address.slice(0, 6), name: address, decimals: 18 };
}

// bytes32 names are padded with NUL bytes; drop them.
function stripNulls(s: string): string {
  return s.replace(/\u0000/g, "");
}

/** Name, symbol and decimals of an ERC-20, cached forever per address. */
export const getTokenMetadata = createEffect(
  {
    name: "getTokenMetadata",
    input: S.string,
    output: { symbol: S.string, name: S.string, decimals: S.number },
    cache: true,
    rateLimit: false,
  },
  async ({ input: address, context }) => {
    if (!client) return fallback(address);
    const addr = address as `0x${string}`;
    try {
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address: addr, abi: ERC20, functionName: "symbol" }),
        client.readContract({ address: addr, abi: ERC20, functionName: "name" }),
        client.readContract({ address: addr, abi: ERC20, functionName: "decimals" }),
      ]);
      return { symbol, name, decimals: Number(decimals) };
    } catch {
      try {
        const [symbol, name, decimals] = await Promise.all([
          client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "symbol" }),
          client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "name" }),
          client.readContract({ address: addr, abi: ERC20_BYTES, functionName: "decimals" }),
        ]);
        return { symbol: stripNulls(hexToString(symbol)), name: stripNulls(hexToString(name)), decimals: Number(decimals) };
      } catch (err) {
        context.log.warn(`token metadata failed for ${address}: ${String(err)}`);
        return fallback(address);
      }
    }
  },
);
