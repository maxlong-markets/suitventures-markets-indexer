import { createEffect, S } from "envio";
import { fetchTransferHistory, type HistoricalTransfer } from "../lib/hypersync";

const transferSchema = S.schema({
  block: S.number,
  logIndex: S.number,
  timestamp: S.number,
  from: S.string,
  to: S.string,
  value: S.string,
});

/**
 * Transfer logs of a token before the block that registered it, from HyperSync.
 * Cached per (token, toBlock). Empty without ENVIO_API_TOKEN so tests and outages
 * never stop indexing; the token then simply has no pre-registration history.
 * The no-token case skips caching (ruling 2) so a deploy that's missing the
 * token can't freeze an empty history in place forever once it's configured.
 */
export const getTransferHistory = createEffect(
  {
    name: "getTransferHistory",
    input: { token: S.string, toBlock: S.number },
    output: S.array(transferSchema),
    cache: true,
    rateLimit: false,
  },
  async ({ input, context }): Promise<HistoricalTransfer[]> => {
    const apiToken = process.env.ENVIO_API_TOKEN;
    if (!apiToken) {
      context.cache = false;
      return [];
    }
    try {
      return await fetchTransferHistory({ token: input.token, toBlock: input.toBlock, apiToken });
    } catch (err) {
      context.log.error(`transfer history failed for ${input.token} up to ${input.toBlock}: ${String(err)}`);
      throw err; // a partial history is worse than a retry
    }
  },
);
