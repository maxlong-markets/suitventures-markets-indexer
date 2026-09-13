export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const HYPERSYNC_URL = "https://4663.hypersync.xyz/query";

export type HistoricalTransfer = {
  block: number;
  logIndex: number;
  timestamp: number;
  from: string;
  to: string;
  value: string; // decimal string; bigint is not JSON
};

export type FetchTransferHistoryResult = {
  transfers: HistoricalTransfer[];
  // Logs that matched the address+topic0 filter but weren't shaped like a
  // standard ERC-20 Transfer (see isErc20TransferLog below), so were not
  // decoded into `transfers`.
  skipped: number;
};

// Reported to `onRetry` before every sleep, so a caller (the effect wrapper)
// can log progress without this module knowing about logging at all.
export type HyperSyncRetryInfo = { attempt: number; status?: number; reason: string; waitMs: number };

type Params = {
  token: string;
  toBlock: number;
  apiToken: string;
  url?: string;
  retryDelayMs?: number;
  onRetry?: (info: HyperSyncRetryInfo) => void;
};

type HyperSyncPage = {
  data: { logs?: HyperSyncLog[]; blocks?: { number: number; timestamp: number | string }[] }[];
  next_block: number;
  archive_height?: number;
};
type HyperSyncLog = {
  block_number: number;
  log_index: number;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
  data: string;
};

const topicToAddress = (topic: string) => "0x" + topic.slice(-40).toLowerCase();

// Exactly 32 bytes: "0x" + 64 hex chars. A shorter/empty or non-standard
// longer `data` is not a plain ERC-20 `value` word.
const DATA_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * True for a log shaped like the standard ERC-20 `Transfer(address indexed
 * from, address indexed to, uint256 value)`: exactly two indexed topics
 * (topic1/topic2) plus a 32-byte data word. HyperSync's log query filters on
 * address and topic0 only (see the `logs` filter below), so it also returns
 * non-ERC-20 events that happen to reuse the same Transfer topic0 — most
 * commonly ERC-721's `Transfer(address indexed from, address indexed to,
 * uint256 indexed tokenId)`, which carries the id as a third indexed topic
 * (topic3) and empty `data`. Decoding one of those under the ERC-20 layout
 * would throw (`BigInt("0x")`) for the empty-data case, or, for some other
 * non-standard `data` length, silently produce a wrong value.
 */
function isErc20TransferLog(log: HyperSyncLog): boolean {
  if (log.topic3 != null) return false; // a 3rd indexed topic: not ERC-20 Transfer
  if (log.topic1 == null || log.topic2 == null) return false;
  return DATA_RE.test(log.data);
}

// "Other retryable failures" (5xx, a rejected fetch, a body-read failure, a
// JSON parse failure) are capped at this many attempts total, then the last
// error is thrown. HTTP 429 has no cap at all: a rate limit must slow the
// indexer, never stop it (FW1 / review finding C1 — a real sync died at
// block 1,289,864 when the old 6-attempt cap ran out under sustained 429s).
const MAX_OTHER_ATTEMPTS = 10;
const MAX_DELAY_MS = 60_000;

// Exponential backoff, capped at 60s, scaled by retryDelayMs/1000 so tests
// with a tiny retryDelayMs stay fast without changing the shape of the curve.
function backoffMs(attempt: number, retryDelayMs: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_DELAY_MS) * (retryDelayMs / 1000);
}

// HyperSync's Retry-After, in seconds, capped the same way as the backoff.
// Not scaled by retryDelayMs: it's the server telling us how long *it* wants,
// not a knob for us to shrink in tests (tests use fake timers for this path).
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_DELAY_MS);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs one HyperSync query, retrying transient failures with exponential
 * backoff. A 429 (the API token's shared quota with envio's own event
 * stream — see FW1) retries forever, since a busy indexer must slow down,
 * never give up. Every other retryable failure — 5xx, a rejected fetch, a
 * body-read failure, a malformed JSON body — shares the same backoff curve
 * but gives up after MAX_OTHER_ATTEMPTS, throwing the last error. Any other
 * 4xx is not retried at all.
 */
async function postQuery(
  url: string,
  apiToken: string,
  body: unknown,
  fetchImpl: typeof fetch,
  retryDelayMs: number,
  onRetry?: (info: HyperSyncRetryInfo) => void,
): Promise<HyperSyncPage> {
  let attempt = 0; // shared, ever-increasing counter: backoff exponent and the reported attempt number
  let otherAttempts = 0; // counts only "other retryable failures", capped at MAX_OTHER_ATTEMPTS
  let lastError: unknown;

  const retry = (info: HyperSyncRetryInfo) => {
    onRetry?.(info);
    return sleep(info.waitMs);
  };

  for (;;) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // A rejected fetch — network error (ECONNRESET, DNS, ...) — is just as
      // transient as a 5xx, so it gets the same retry treatment.
      lastError = err;
      otherAttempts += 1;
      if (otherAttempts >= MAX_OTHER_ATTEMPTS) throw lastError; // no sleep after the last attempt
      attempt += 1;
      await retry({ attempt, reason: "network error", waitMs: backoffMs(attempt - 1, retryDelayMs) });
      continue;
    }

    if (res.ok) {
      try {
        return (await res.json()) as HyperSyncPage;
      } catch (err) {
        // A malformed JSON body on an ok response: also transient-shaped, retry.
        lastError = err;
        otherAttempts += 1;
        if (otherAttempts >= MAX_OTHER_ATTEMPTS) throw lastError;
        attempt += 1;
        await retry({ attempt, status: res.status, reason: "invalid JSON body", waitMs: backoffMs(attempt - 1, retryDelayMs) });
        continue;
      }
    }

    // Not ok. Read the body inside the try, whatever the status: a body-read
    // failure (a dropped connection mid-stream, say) is just another
    // retryable failure, not a throw that escapes the retry loop entirely.
    let bodyReadFailed = false;
    try {
      lastError = new Error(`HyperSync ${res.status}: ${await res.text()}`);
    } catch (err) {
      lastError = err;
      bodyReadFailed = true;
    }

    if (res.status === 429) {
      attempt += 1;
      const waitMs = retryAfterMs(res) ?? backoffMs(attempt - 1, retryDelayMs);
      await retry({ attempt, status: res.status, reason: "rate limited", waitMs });
      continue;
    }
    if (res.status < 500 && !bodyReadFailed) {
      throw lastError; // other 4xx: not retryable
    }
    // 5xx, or a body-read failure on any other status: "other retryable failure".
    otherAttempts += 1;
    if (otherAttempts >= MAX_OTHER_ATTEMPTS) throw lastError;
    attempt += 1;
    await retry({
      attempt,
      status: res.status,
      reason: bodyReadFailed ? "body read failed" : `HTTP ${res.status}`,
      waitMs: backoffMs(attempt - 1, retryDelayMs),
    });
  }
}

/**
 * One page for `requestFromBlock`, retrying a lagging archive node (HTTP
 * succeeds, past postQuery's own retries, but `next_block` doesn't advance
 * past its own from_block — transient) with the same capped backoff as
 * postQuery's other retryable failures (FW1), then giving up. A structurally
 * malformed response (no data array, no integer next_block) is not
 * transient-shaped and throws immediately instead.
 */
async function fetchPage(
  url: string,
  apiToken: string,
  requestBody: unknown,
  fetchImpl: typeof fetch,
  retryDelayMs: number,
  requestFromBlock: number,
  onRetry?: (info: HyperSyncRetryInfo) => void,
): Promise<HyperSyncPage> {
  for (let stall = 0; ; stall += 1) {
    const candidate = await postQuery(url, apiToken, requestBody, fetchImpl, retryDelayMs, onRetry);
    if (!Array.isArray(candidate.data) || !Number.isInteger(candidate.next_block)) {
      // Returned as HTTP 200, this is worse than an error: silently
      // returning what little we have would let the caller cache a
      // truncated history and mark it loaded forever (task-9b review
      // finding B). Throw instead, the same as a HyperSync HTTP failure, so
      // it's never cached.
      throw new Error(`HyperSync response malformed for block ${requestFromBlock}: missing data array or next_block`);
    }
    if (candidate.next_block > requestFromBlock) return candidate;
    if (stall + 1 >= MAX_OTHER_ATTEMPTS) {
      throw new Error(`HyperSync did not advance past block ${requestFromBlock} (next_block=${String(candidate.next_block)})`);
    }
    const waitMs = backoffMs(stall, retryDelayMs);
    onRetry?.({ attempt: stall + 1, reason: `no progress past block ${requestFromBlock}`, waitMs });
    await sleep(waitMs);
  }
}

/**
 * Every ERC-20 Transfer log of `token` in blocks [0, toBlock], ordered by block then
 * log index, plus a count of same-topic0 logs that weren't shaped like a standard
 * ERC-20 Transfer (skipped, not decoded — see isErc20TransferLog). Used once per
 * token to replay the transfers Envio cannot deliver (those before the block that
 * registered the token). HyperSync's to_block is exclusive.
 */
export async function fetchTransferHistory(params: Params, fetchImpl: typeof fetch = fetch): Promise<FetchTransferHistoryResult> {
  const { token, toBlock, apiToken, onRetry } = params;
  const url = params.url ?? HYPERSYNC_URL;
  const retryDelayMs = params.retryDelayMs ?? 1000;
  if (toBlock < 0) return { transfers: [], skipped: 0 };
  const endExclusive = toBlock + 1;
  const out: HistoricalTransfer[] = [];
  let skipped = 0;
  let fromBlock = 0;
  while (fromBlock < endExclusive) {
    const requestFromBlock = fromBlock;
    const requestBody = {
      from_block: requestFromBlock,
      to_block: endExclusive,
      logs: [{ address: [token.toLowerCase()], topics: [[TRANSFER_TOPIC]] }],
      field_selection: {
        block: ["number", "timestamp"],
        log: ["block_number", "log_index", "topic1", "topic2", "topic3", "data"],
      },
    };
    const page = await fetchPage(url, apiToken, requestBody, fetchImpl, retryDelayMs, requestFromBlock, onRetry);
    // Build one block-timestamp map across every chunk of this page (not
    // per-chunk): a log and the block that times it can land in different
    // chunks of the same response.
    const timestamps = new Map<number, number>();
    for (const chunk of page.data) {
      for (const b of chunk.blocks ?? []) {
        timestamps.set(Number(b.number), Number(b.timestamp));
      }
    }
    for (const chunk of page.data) {
      for (const log of chunk.logs ?? []) {
        if (!isErc20TransferLog(log)) {
          skipped += 1;
          continue;
        }
        out.push({
          block: Number(log.block_number),
          logIndex: Number(log.log_index),
          timestamp: timestamps.get(Number(log.block_number)) ?? 0,
          from: topicToAddress(log.topic1!),
          to: topicToAddress(log.topic2!),
          value: BigInt(log.data).toString(),
        });
      }
    }
    fromBlock = page.next_block;
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { transfers: out, skipped };
}
