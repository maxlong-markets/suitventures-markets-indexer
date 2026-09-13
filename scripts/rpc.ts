import { createPublicClient, http, defineChain } from "viem";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ENVIO_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"] } },
});

export const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(undefined, { batch: true }),
});
