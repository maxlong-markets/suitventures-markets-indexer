import { client } from "./rpc.ts";

const target = Number(process.argv[2]);
if (!Number.isFinite(target)) {
  console.error("usage: npm run block-at -- <unix seconds>");
  process.exit(1);
}

let lo = 0n;
let hi = await client.getBlockNumber();
while (lo < hi) {
  const mid = (lo + hi) / 2n;
  const block = await client.getBlock({ blockNumber: mid });
  if (Number(block.timestamp) < target) lo = mid + 1n;
  else hi = mid;
}
const found = await client.getBlock({ blockNumber: lo });
console.log(JSON.stringify({ block: Number(lo), timestamp: Number(found.timestamp) }));
