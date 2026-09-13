import { defineConfig } from "vitest/config";
import { loadEnv, createLogger } from "vite";

const live = process.env.ENVIO_LIVE_TEST === "1";

// Every third-party package under node_modules here (@uniswap/v3-sdk and its
// dependencies) ships a .js file whose sourcemap points at TypeScript
// sources that were never published, so Vite's own sourcemap resolution
// warns once per file, every run. Harmless, but it drowns out real warnings
// in test output — filtered by message text since Vite has no per-warning
// config for this specific case.
const MISSING_SOURCEMAP_WARNING = "points to missing source files";

export function shouldSuppressViteWarning(msg: string): boolean {
  return msg.includes(MISSING_SOURCEMAP_WARNING);
}

const logger = createLogger();
const warn = logger.warn.bind(logger);
logger.warn = (msg, options) => {
  if (shouldSuppressViteWarning(msg)) return;
  warn(msg, options);
};

export default defineConfig({
  customLogger: logger,
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
