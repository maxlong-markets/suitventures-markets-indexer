import { createEffect, S } from "envio";
import { fetchTransferHistory, type HistoricalTransfer } from "../lib/hypersync";

// Without ENVIO_API_TOKEN, every call below silently returns an empty
// history while the Initialize handler still marks historyLoaded true, so
// supply and holder counts come out wrong for every token, forever, with no
// error anywhere. Fail loudly at startup instead. VITEST is set by the test
// runner itself, which deliberately blanks this variable offline (see
// vitest.config.ts): the per-call fallback below still exists for that case.
if (!process.env.ENVIO_API_TOKEN && !process.env.VITEST) {
  throw new Error("ENVIO_API_TOKEN is required: the transfer-history replay calls HyperSync directly (see README Deploy)");
}

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
 * Never persisted to the cache: one row per token would sit there as dead weight
 * once historyLoaded flips true, and a capped/incomplete result (see maxTransfers
 * below) must never be replayed from a stale cache row on a later run. Envio still
 * dedupes repeat calls with the same input within a single run/batch regardless.
 * When ENVIO_API_TOKEN is unset, this returns an empty history so tests and a
 * deploy missing the token never stop indexing — but the calling Initialize
 * handler still marks the token's historyLoaded: true regardless, so a token
 * first discovered before the API token is configured never gets its
 * pre-registration history, even after the token is later set.
 * A log that matches the address/topic0 filter but isn't shaped like a
 * standard ERC-20 Transfer (an ERC-721 id-indexed Transfer, say) is skipped,
 * not decoded, by `fetchTransferHistory`; when any are skipped this logs a
 * warning, since the output schema only carries the transfers themselves.
 * Rate-limited (not the HyperSync HTTP retry/backoff, which lives in
 * `fetchTransferHistory` itself) because preload can call this once per new
 * token discovered in a batch, all at once — and kept low because these
 * queries share the API token's HyperSync quota with envio's own event
 * stream, so a fast burst here starves the indexer's main event stream of
 * that same quota.
 */
export const getTransferHistory = createEffect(
  {
    name: "getTransferHistory",
    input: { token: S.string, toBlock: S.number },
    output: S.array(transferSchema),
    cache: false,
    rateLimit: { calls: 2, per: "second" },
  },
  async ({ input, context }): Promise<HistoricalTransfer[]> => {
    const apiToken = process.env.ENVIO_API_TOKEN;
    if (!apiToken) {
      return [];
    }
    try {
      const { transfers, skipped, capped } = await fetchTransferHistory({
        token: input.token,
        toBlock: input.toBlock,
        apiToken,
        onRetry: (info) => {
          // A HyperSync rate limit has no attempt cap, so a busy sync can
          // retry for a long time; log occasionally rather than on every
          // attempt so a stuck replay is still visible without flooding the
          // log. Never logs the URL or the API token, only the ERC-20 token,
          // the target block, the failure and the wait.
          const shouldLog = info.attempt === 1 || info.attempt === 5 || info.attempt === 10 || (info.attempt > 10 && info.attempt % 10 === 0);
          if (shouldLog) {
            context.log.warn(
              `transfer history for ${input.token} up to ${input.toBlock}: retry ${info.attempt} ` +
                `(${info.status ?? info.reason}), waiting ${info.waitMs}ms`,
            );
          }
        },
      });
      if (skipped > 0) {
        context.log.warn(`transfer history for ${input.token} up to ${input.toBlock}: skipped ${skipped} non-ERC-20 Transfer log(s)`);
      }
      if (capped) {
        context.log.error(
          `transfer history for ${input.token} up to ${input.toBlock}: exceeded the transfer cap, ` +
            `holders and supply for this token will be incomplete`,
        );
      }
      return transfers;
    } catch (err) {
      context.log.error(`transfer history failed for ${input.token} up to ${input.toBlock}: ${String(err)}`);
      throw err; // a partial history is worse than a retry
    }
  },
);
