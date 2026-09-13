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
 * Cached per (token, toBlock). When ENVIO_API_TOKEN is unset, this returns an
 * empty, UNCACHED history (ruling 2) so tests and a deploy missing the token
 * never stop indexing — but the calling Initialize handler still marks the
 * token's historyLoaded: true regardless, so a token first discovered before
 * the API token is configured never gets its pre-registration history, even
 * after the token is later set (review finding M1).
 * A log that matches the address/topic0 filter but isn't shaped like a
 * standard ERC-20 Transfer (an ERC-721 id-indexed Transfer, say) is skipped,
 * not decoded, by `fetchTransferHistory`; when any are skipped this logs a
 * warning, since the output schema only carries the transfers themselves.
 * Rate-limited (not the HyperSync HTTP retry/backoff, which lives in
 * `fetchTransferHistory` itself) because preload can call this once per new
 * token discovered in a batch, all at once.
 */
export const getTransferHistory = createEffect(
  {
    name: "getTransferHistory",
    input: { token: S.string, toBlock: S.number },
    output: S.array(transferSchema),
    cache: true,
    rateLimit: { calls: 5, per: "second" },
  },
  async ({ input, context }): Promise<HistoricalTransfer[]> => {
    const apiToken = process.env.ENVIO_API_TOKEN;
    if (!apiToken) {
      context.cache = false;
      return [];
    }
    try {
      const { transfers, skipped } = await fetchTransferHistory({ token: input.token, toBlock: input.toBlock, apiToken });
      if (skipped > 0) {
        context.log.warn(`transfer history for ${input.token} up to ${input.toBlock}: skipped ${skipped} non-ERC-20 Transfer log(s)`);
      }
      return transfers;
    } catch (err) {
      context.log.error(`transfer history failed for ${input.token} up to ${input.toBlock}: ${String(err)}`);
      throw err; // a partial history is worse than a retry
    }
  },
);
