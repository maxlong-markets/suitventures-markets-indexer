import { readFileSync, writeFileSync } from "node:fs";
import { parseAbi } from "viem";
import { client } from "./rpc.ts";

const PROXY = parseAbi([
  "function aggregator() view returns (address)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

type Row = {
  address: string; symbol: string; name: string; decimals: number;
  chainlinkProxy: string | null; chainlinkAggregator: string | null; chainlinkDecimals: number | null;
};

const rows = JSON.parse(readFileSync("config/quotes.json", "utf8")) as Row[];
for (const row of rows) {
  if (!row.chainlinkProxy) continue;
  const proxy = row.chainlinkProxy as `0x${string}`;
  const [aggregator, decimals, description, latest] = await Promise.all([
    client.readContract({ address: proxy, abi: PROXY, functionName: "aggregator" }),
    client.readContract({ address: proxy, abi: PROXY, functionName: "decimals" }),
    client.readContract({ address: proxy, abi: PROXY, functionName: "description" }),
    client.readContract({ address: proxy, abi: PROXY, functionName: "latestRoundData" }),
  ]);
  // On-chain descriptions use either "Robinhood <TICKER> / USD" or "RH<TICKER> / USD".
  const escaped = row.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\b(?:RH)?" + escaped + "\\b", "i");
  if (!re.test(description)) {
    throw new Error(`${row.symbol}: proxy ${proxy} describes itself as "${description}"`);
  }
  row.chainlinkAggregator = aggregator.toLowerCase();
  row.chainlinkDecimals = Number(decimals);
  console.log(`${row.symbol}: ${description} = ${Number(latest[1]) / 10 ** Number(decimals)} (aggregator ${aggregator})`);
}
writeFileSync("config/quotes.json", JSON.stringify(rows, null, 2) + "\n");
