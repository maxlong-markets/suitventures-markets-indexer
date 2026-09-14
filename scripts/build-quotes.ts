import { readFileSync, writeFileSync } from "node:fs";
import { parseAbi } from "viem";
import { client } from "./rpc.ts";
import { classifyQuoteToken, USDG } from "./quoteClassification.ts";

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

type Row = {
  address: string; symbol: string; name: string; decimals: number;
  chainlinkProxy: string | null; chainlinkAggregator: string | null; chainlinkDecimals: number | null;
};

type DenylistRow = { address: string; symbol: string; reason: string };

// Chainlink's published feed list (see data/chainlink-feeds-robinhood-2026-09-13.json).
// Only the fields build-quotes reads are declared here.
type Feed = {
  proxyAddress: string;
  name: string;
  docs?: { baseAsset?: string; blockchainName?: string };
};

const snapshot = JSON.parse(readFileSync("data/pons-graduated-pools-2026-09-10.json", "utf8")) as { quoteToken: string }[];
const existing = new Map((JSON.parse(readFileSync("config/quotes.json", "utf8")) as Row[]).map((r) => [r.address.toLowerCase(), r]));
const feeds = JSON.parse(readFileSync("data/chainlink-feeds-robinhood-2026-09-13.json", "utf8")) as Feed[];

// Most feeds carry docs.baseAsset (e.g. "NVDA"), but some (DELL) file it with a leading
// "RH" glued on ("RHDELL") -- the same RH-prefix quirk resolve-feeds.ts already works
// around on the on-chain description() side. A few feeds (SGOV, USAR) have no usable
// docs.baseAsset at all, so fall back to parsing the ticker out of `name` instead
// (e.g. "Robinhood SGOV-USD" or "Robinhood AAPL / USD").
function feedKey(feed: Feed): string | undefined {
  if (feed.docs?.blockchainName === "Robinhood" && feed.docs?.baseAsset) {
    return feed.docs.baseAsset.toUpperCase().replace(/^RH/, "");
  }
  return feed.name.match(/^Robinhood[ -]([A-Z.]+)[ -]/)?.[1]?.toUpperCase();
}

// Group rather than collapse: the feed list has a handful of unrelated duplicate keys
// (e.g. both "weETH" and "WEETH" file under WEETH with different proxies) that never
// come up as an on-chain stock-token symbol. Only throw if a key we actually need to
// resolve below turns out to be genuinely ambiguous, instead of guessing which of two
// proxies is right -- or failing the whole run over a collision that doesn't matter here.
const feedsByKey = new Map<string, Feed[]>();
for (const feed of feeds) {
  const key = feedKey(feed);
  if (!key) continue;
  const list = feedsByKey.get(key);
  if (list) list.push(feed);
  else feedsByKey.set(key, [feed]);
}

function resolveFeed(symbol: string): Feed | undefined {
  const candidates = feedsByKey.get(symbol.toUpperCase());
  if (!candidates || candidates.length === 0) return undefined;
  const distinctProxies = new Set(candidates.map((f) => f.proxyAddress.toLowerCase()));
  if (distinctProxies.size > 1) {
    throw new Error(
      `ambiguous Chainlink feed key "${symbol.toUpperCase()}": ${candidates.map((f) => f.proxyAddress).join(", ")} all claim it`,
    );
  }
  return candidates[0];
}

const addresses = [...new Set(snapshot.map((p) => p.quoteToken.toLowerCase()))].filter((a) => a !== ZERO);
const addressSet = new Set(addresses);

const rows: Row[] = [];
const denylist: DenylistRow[] = [];
const skipped: string[] = [];
for (const address of addresses) {
  const target = address as `0x${string}`;
  let symbol: string;
  let name: string;
  let decimals: number;
  try {
    [symbol, name, decimals] = await Promise.all([
      client.readContract({ address: target, abi: ERC20, functionName: "symbol" }),
      client.readContract({ address: target, abi: ERC20, functionName: "name" }),
      client.readContract({ address: target, abi: ERC20, functionName: "decimals" }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`skip ${address}: ${message}`);
    skipped.push(address);
    continue;
  }
  if (classifyQuoteToken(address, symbol, name) === "excluded") {
    // Not a stock token: anyone can still pair it with a quote on-chain, so it
    // must be denylisted (src/lib/denylist.ts), not just left out of the quote
    // allowlist here.
    denylist.push({ address, symbol, reason: "non-stock pairing asset" });
    continue;
  }
  const prev = existing.get(address);
  // USDG's USD price is pinned at 1 by the spec even though a USDG Chainlink feed exists,
  // so it never gets a chainlinkProxy here.
  const chainlinkProxy =
    address === USDG
      ? null
      : (resolveFeed(symbol)?.proxyAddress?.toLowerCase() ?? prev?.chainlinkProxy ?? null);
  rows.push({
    address, symbol, name, decimals: Number(decimals),
    chainlinkProxy,
    chainlinkAggregator: prev?.chainlinkAggregator ?? null,
    chainlinkDecimals: prev?.chainlinkDecimals ?? null,
  });
}

// A previous quotes.json row whose address is no longer in the frozen Pons snapshot at
// all would otherwise vanish here with no trace -- fail loudly instead of guessing.
let dropped = 0;
for (const [address, prevRow] of existing) {
  if (!addressSet.has(address)) {
    console.error(`dropped ${address} (${prevRow.symbol}): not in the snapshot`);
    dropped++;
  }
}

rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
writeFileSync("config/quotes.json", JSON.stringify(rows, null, 2) + "\n");
console.log(`wrote ${rows.length} quotes`);

denylist.sort((a, b) => a.symbol.localeCompare(b.symbol));
writeFileSync("config/token-denylist.json", JSON.stringify(denylist, null, 2) + "\n");
console.log(`wrote ${denylist.length} denylisted token(s): ${denylist.map((d) => d.symbol).join(", ")}`);
if (skipped.length > 0) {
  console.log(`skipped ${skipped.length} address(es): ${skipped.join(", ")}`);
}
if (skipped.length > 0 || dropped > 0) {
  process.exitCode = 1;
}
