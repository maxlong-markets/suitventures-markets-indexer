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

type Params = { token: string; toBlock: number; apiToken: string; url?: string; retryDelayMs?: number };

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

const MAX_ATTEMPTS = 6;
const MAX_DELAY_MS = 16_000;

// Exponential backoff, capped at 16s, scaled by retryDelayMs/1000 so tests
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

async function postQuery(url: string, apiToken: string, body: unknown, fetchImpl: typeof fetch, retryDelayMs: number): Promise<HyperSyncPage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
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
      if (!isLastAttempt) await sleep(backoffMs(attempt, retryDelayMs));
      continue;
    }
    if (res.ok) {
      try {
        return (await res.json()) as HyperSyncPage;
      } catch (err) {
        // A malformed JSON body on an ok response: also transient-shaped, retry.
        lastError = err;
        if (!isLastAttempt) await sleep(backoffMs(attempt, retryDelayMs));
        continue;
      }
    }
    lastError = new Error(`HyperSync ${res.status}: ${await res.text()}`);
    if (res.status !== 429 && res.status < 500) break; // other 4xx: not retryable, throw now
    if (!isLastAttempt) {
      await sleep(retryAfterMs(res) ?? backoffMs(attempt, retryDelayMs));
    }
  }
  throw lastError;
}

/**
 * Every ERC-20 Transfer log of `token` in blocks [0, toBlock], ordered by block then
 * log index, plus a count of same-topic0 logs that weren't shaped like a standard
 * ERC-20 Transfer (skipped, not decoded — see isErc20TransferLog). Used once per
 * token to replay the transfers Envio cannot deliver (those before the block that
 * registered the token). HyperSync's to_block is exclusive.
 */
export async function fetchTransferHistory(params: Params, fetchImpl: typeof fetch = fetch): Promise<FetchTransferHistoryResult> {
  const { token, toBlock, apiToken } = params;
  const url = params.url ?? HYPERSYNC_URL;
  const retryDelayMs = params.retryDelayMs ?? 500;
  if (toBlock < 0) return { transfers: [], skipped: 0 };
  const endExclusive = toBlock + 1;
  const out: HistoricalTransfer[] = [];
  let skipped = 0;
  let fromBlock = 0;
  while (fromBlock < endExclusive) {
    const requestFromBlock = fromBlock;
    const page = await postQuery(url, apiToken, {
      from_block: requestFromBlock,
      to_block: endExclusive,
      logs: [{ address: [token.toLowerCase()], topics: [[TRANSFER_TOPIC]] }],
      field_selection: {
        block: ["number", "timestamp"],
        log: ["block_number", "log_index", "topic1", "topic2", "topic3", "data"],
      },
    }, fetchImpl, retryDelayMs);
    if (!Array.isArray(page.data) || !Number.isInteger(page.next_block) || !(page.next_block > requestFromBlock)) {
      // A page that doesn't advance (or lacks a usable next_block/data array)
      // returned as HTTP 200 is worse than an error: silently returning what
      // little we have would let the caller cache a truncated history and
      // mark it loaded forever (task-9b review finding B). Throw instead, the
      // same as a HyperSync HTTP failure, so it's never cached.
      throw new Error(`HyperSync did not advance past block ${requestFromBlock} (next_block=${String(page.next_block)})`);
    }
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
