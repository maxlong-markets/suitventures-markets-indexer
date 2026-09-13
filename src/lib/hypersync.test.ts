import { describe, it, expect, vi } from "vitest";
import { fetchTransferHistory, TRANSFER_TOPIC } from "./hypersync";

const TOKEN = "0xc9e9ab90654f82893d7fd18b62f694992e8cef29";
const pad = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2).toLowerCase();
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

function page(logs: object[], blocks: object[], next_block: number) {
  return { data: [{ logs, blocks }], next_block, archive_height: 99_999_999 };
}

describe("fetchTransferHistory", () => {
  it("queries HyperSync with the token, topic and exclusive to_block, and decodes logs in order", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(page(
        [
          { block_number: 101, log_index: 3, topic1: pad(A), topic2: pad(B), data: "0x" + (5n).toString(16).padStart(64, "0") },
          { block_number: 100, log_index: 1, topic1: pad(ZERO), topic2: pad(A), data: "0x" + (1000n).toString(16).padStart(64, "0") },
        ],
        [{ number: 100, timestamp: "0x65000000" }, { number: 101, timestamp: 1694498817 }],
        200,
      )), { status: 200 });
    });
    const out = await fetchTransferHistory({ token: TOKEN, toBlock: 199, apiToken: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://4663.hypersync.xyz/query");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.from_block).toBe(0);
    expect(body.to_block).toBe(200);
    expect(body.logs).toEqual([{ address: [TOKEN], topics: [[TRANSFER_TOPIC]] }]);
    expect(out).toEqual([
      { block: 100, logIndex: 1, timestamp: 0x65000000, from: ZERO, to: A, value: "1000" },
      { block: 101, logIndex: 3, timestamp: 1694498817, from: A, to: B, value: "5" },
    ]);
  });
  it("follows next_block until the range is covered", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify(page([{ block_number: 10, log_index: 0, topic1: pad(ZERO), topic2: pad(A), data: "0x" + "1".padStart(64, "0") }], [{ number: 10, timestamp: 10 }], 50)), { status: 200 });
      return new Response(JSON.stringify(page([{ block_number: 60, log_index: 0, topic1: pad(A), topic2: pad(B), data: "0x" + "1".padStart(64, "0") }], [{ number: 60, timestamp: 60 }], 100)), { status: 200 });
    });
    const out = await fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(2);
    expect(out.map((t) => t.block)).toEqual([10, 60]);
  });
  it("returns nothing for toBlock below zero", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchTransferHistory({ token: TOKEN, toBlock: -1, apiToken: "tok" }, fetchImpl as unknown as typeof fetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    const out = await fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1 }, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(2);
    expect(out).toEqual([]);
  });
});
