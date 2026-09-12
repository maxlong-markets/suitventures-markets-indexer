import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    env: {
      ...loadEnv("test", process.cwd(), "ENVIO_"),
      // Tests create candles at every interval regardless of block height.
      ENVIO_CANDLES_1M_START_BLOCK: "0",
      ENVIO_CANDLES_5M_START_BLOCK: "0",
    },
  },
});
