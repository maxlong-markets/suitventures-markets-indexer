import { readFileSync, writeFileSync } from "node:fs";
import { parseAbi } from "viem";
import { client } from "./rpc.ts";

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

// Quotes Pons accepts that are not stock tokens. Add symbols here to exclude them.
const EXCLUDED_SYMBOLS = new Set(["WETH", "ETH", "cbBTC", "TAO", "WYFI", "SKHY", "BULL"]);
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ZERO = "0x0000000000000000000000000000000000000000";

type Row = {
  address: string; symbol: string; name: string; decimals: number;
  chainlinkProxy: string | null; chainlinkAggregator: string | null; chainlinkDecimals: number | null;
};

// Chainlink's published feed list (see data/chainlink-feeds-robinhood-2026-09-13.json).
// Only the fields build-quotes reads are declared here.
type Feed = {
  proxyAddress: string;
  docs?: { baseAsset?: string; blockchainName?: string };
};

const snapshot = JSON.parse(readFileSync("data/pons-graduated-pools-2026-09-10.json", "utf8")) as { quoteToken: string }[];
const existing = new Map((JSON.parse(readFileSync("config/quotes.json", "utf8")) as Row[]).map((r) => [r.address.toLowerCase(), r]));
const feeds = JSON.parse(readFileSync("data/chainlink-feeds-robinhood-2026-09-13.json", "utf8")) as Feed[];
const feedBySymbol = new Map(
  feeds
    .filter((f) => f.docs?.blockchainName === "Robinhood" && f.docs?.baseAsset)
    .map((f) => [f.docs!.baseAsset!.toUpperCase(), f]),
);
const addresses = [...new Set(snapshot.map((p) => p.quoteToken.toLowerCase()))].filter((a) => a !== ZERO);

const rows: Row[] = [];
const skipped: string[] = [];
for (const address of addresses) {
  const target = address as `0x${string}`;
  try {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: target, abi: ERC20, functionName: "symbol" }),
      client.readContract({ address: target, abi: ERC20, functionName: "name" }),
      client.readContract({ address: target, abi: ERC20, functionName: "decimals" }),
    ]);
    if (address !== USDG && EXCLUDED_SYMBOLS.has(symbol)) continue;
    const prev = existing.get(address);
    // USDG's USD price is pinned at 1 by the spec even though a USDG Chainlink feed exists,
    // so it never gets a chainlinkProxy here.
    const chainlinkProxy =
      address === USDG
        ? null
        : (feedBySymbol.get(symbol.toUpperCase())?.proxyAddress.toLowerCase() ?? prev?.chainlinkProxy ?? null);
    rows.push({
      address, symbol, name, decimals: Number(decimals),
      chainlinkProxy,
      chainlinkAggregator: prev?.chainlinkAggregator ?? null,
      chainlinkDecimals: prev?.chainlinkDecimals ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`skip ${address}: ${message}`);
    skipped.push(address);
  }
}
rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
writeFileSync("config/quotes.json", JSON.stringify(rows, null, 2) + "\n");
console.log(`wrote ${rows.length} quotes`);
if (skipped.length > 0) {
  console.log(`skipped ${skipped.length} address(es): ${skipped.join(", ")}`);
}
