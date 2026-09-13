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

type Params = { token: string; toBlock: number; apiToken: string; url?: string; retryDelayMs?: number };

type HyperSyncPage = {
  data: { logs?: HyperSyncLog[]; blocks?: { number: number; timestamp: number | string }[] }[];
  next_block: number;
  archive_height?: number;
};
type HyperSyncLog = { block_number: number; log_index: number; topic1: string; topic2: string; data: string };

const topicToAddress = (topic: string) => "0x" + topic.slice(-40).toLowerCase();

async function postQuery(url: string, apiToken: string, body: unknown, fetchImpl: typeof fetch, retryDelayMs: number): Promise<HyperSyncPage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as HyperSyncPage;
    lastError = new Error(`HyperSync ${res.status}: ${await res.text()}`);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
  }
  throw lastError;
}

/**
 * Every Transfer log of `token` in blocks [0, toBlock], ordered by block then log index.
 * Used once per token to replay the transfers Envio cannot deliver (those before the
 * block that registered the token). HyperSync's to_block is exclusive.
 */
export async function fetchTransferHistory(params: Params, fetchImpl: typeof fetch = fetch): Promise<HistoricalTransfer[]> {
  const { token, toBlock, apiToken } = params;
  const url = params.url ?? HYPERSYNC_URL;
  const retryDelayMs = params.retryDelayMs ?? 500;
  if (toBlock < 0) return [];
  const endExclusive = toBlock + 1;
  const out: HistoricalTransfer[] = [];
  let fromBlock = 0;
  while (fromBlock < endExclusive) {
    const page = await postQuery(url, apiToken, {
      from_block: fromBlock,
      to_block: endExclusive,
      logs: [{ address: [token.toLowerCase()], topics: [[TRANSFER_TOPIC]] }],
      field_selection: {
        block: ["number", "timestamp"],
        log: ["block_number", "log_index", "topic1", "topic2", "data"],
      },
    }, fetchImpl, retryDelayMs);
    for (const chunk of page.data) {
      const timestamps = new Map((chunk.blocks ?? []).map((b) => [Number(b.number), Number(b.timestamp)]));
      for (const log of chunk.logs ?? []) {
        out.push({
          block: Number(log.block_number),
          logIndex: Number(log.log_index),
          timestamp: timestamps.get(Number(log.block_number)) ?? 0,
          from: topicToAddress(log.topic1),
          to: topicToAddress(log.topic2),
          value: BigInt(log.data).toString(),
        });
      }
    }
    if (!(page.next_block > fromBlock)) break; // no progress: stop rather than loop forever
    fromBlock = page.next_block;
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return out;
}
