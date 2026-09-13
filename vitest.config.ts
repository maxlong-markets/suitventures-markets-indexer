import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

const live = process.env.ENVIO_LIVE_TEST === "1";

export default defineConfig({
  test: {
    env: {
      ...loadEnv("test", process.cwd(), "ENVIO_"),
      // Unit tests stay offline: no RPC metadata reads, no HyperSync calls.
      ...(live ? {} : { ENVIO_RPC_URL: "", ENVIO_API_TOKEN: "" }),
      // Tests create candles at every interval regardless of block height.
      ENVIO_CANDLES_1M_START_BLOCK: "0",
      ENVIO_CANDLES_5M_START_BLOCK: "0",
    },
  },
});
