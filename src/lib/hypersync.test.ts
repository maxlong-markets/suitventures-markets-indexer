import { describe, it, expect, vi } from "vitest";
import { fetchTransferHistory, TRANSFER_TOPIC, createRatePause } from "./hypersync";

const TOKEN = "0xc9e9ab90654f82893d7fd18b62f694992e8cef29";
const pad = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2).toLowerCase();
const hex = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
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
    const result = await fetchTransferHistory({ token: TOKEN, toBlock: 199, apiToken: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://4663.hypersync.xyz/query");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.from_block).toBe(0);
    expect(body.to_block).toBe(200);
    expect(body.logs).toEqual([{ address: [TOKEN], topics: [[TRANSFER_TOPIC]] }]);
    expect(result.skipped).toBe(0);
    expect(result.transfers).toEqual([
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
    const result = await fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(2);
    expect(result.transfers.map((t) => t.block)).toEqual([10, 60]);
  });
  it("returns nothing for toBlock below zero", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchTransferHistory({ token: TOKEN, toBlock: -1, apiToken: "tok" }, fetchImpl as unknown as typeof fetch)).toEqual({ transfers: [], skipped: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    const result = await fetchTransferHistory(
      { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, pause: createRatePause() },
      fetchImpl as unknown as typeof fetch,
    );
    expect(n).toBe(2);
    expect(result.transfers).toEqual([]);
  });

  // A HyperSync rate limit must slow the indexer, never stop it. The old
  // 6-attempt cap died mid-sync on a real run (block 1,289,864); 429s now
  // retry without any attempt cap.
  it("retries a 429 eight times (well past the old 6-attempt cap), then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n <= 8) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    const result = await fetchTransferHistory(
      { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, pause: createRatePause() },
      fetchImpl as unknown as typeof fetch,
    );
    expect(n).toBe(9);
    expect(result.transfers).toEqual([]);
  });

  it("retries a 429 whose body read throws, instead of letting the read failure escape", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        const res = new Response("slow down", { status: 429 });
        vi.spyOn(res, "text").mockRejectedValueOnce(new Error("stream closed"));
        return res;
      }
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    const result = await fetchTransferHistory(
      { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, pause: createRatePause() },
      fetchImpl as unknown as typeof fetch,
    );
    expect(n).toBe(2);
    expect(result.transfers).toEqual([]);
  });

  // A non-429 4xx is never retried -- but before this, a body-read failure on
  // one (a dropped connection mid-stream, say) fell into the same bucket as a
  // 5xx's body-read failure and got retried up to 10 times anyway, about 4
  // minutes at defaults, before finally throwing. It must throw on the very
  // first attempt, the same as a 4xx whose body read succeeds.
  it("throws immediately on a non-429 4xx whose body read fails, with no retry", async () => {
    const fetchImpl = vi.fn(async () => {
      const res = new Response("nope", { status: 401 });
      vi.spyOn(res, "text").mockRejectedValueOnce(new Error("stream closed"));
      return res;
    });
    await expect(
      fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1 }, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws after 10 attempts on a persistent 5xx, with no sleep after the last one", async () => {
    let n = 0;
    let retries = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return new Response("boom", { status: 503 });
    });
    await expect(
      fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, onRetry: () => (retries += 1) },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/503/);
    expect(n).toBe(10);
    // onRetry runs before every sleep, so a sleep after the last (10th)
    // attempt would show up here as 10, not 9.
    expect(retries).toBe(9);
  });

  it("retries a page that does not advance, then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      const req = JSON.parse(String(init?.body)) as { from_block: number };
      if (n <= 3) return new Response(JSON.stringify(page([], [], req.from_block)), { status: 200 }); // lagging node: no progress
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    const result = await fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1 }, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(4);
    expect(result.transfers).toEqual([]);
  });

  it("throws when a page never advances after 10 attempts", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { from_block: number };
      return new Response(JSON.stringify(page([], [], req.from_block)), { status: 200 });
    });
    await expect(
      fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1 }, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it("reports increasing attempt numbers to onRetry", async () => {
    let n = 0;
    const attempts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n <= 3) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    await fetchTransferHistory(
      {
        token: TOKEN,
        toBlock: 99,
        apiToken: "tok",
        retryDelayMs: 1,
        pause: createRatePause(),
        onRetry: (info) => attempts.push(info.attempt),
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(attempts).toEqual([1, 2, 3]);
  });

  // HyperSync's log filter matches on address + topic0 only, so a non-ERC-20
  // event that reuses the Transfer topic0 (ERC-721's
  // `Transfer(address,address,uint256 indexed)`, id-indexed, empty data) or a
  // log with non-standard `data` comes back too. Both must be skipped, not
  // decoded, and counted rather than silently corrupting a value or throwing.
  it("skips non-ERC-20-shaped logs (same topic0, different layout) mixed with valid ones", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(page(
        [
          { block_number: 100, log_index: 0, topic1: pad(ZERO), topic2: pad(A), data: hex(1000n) }, // valid ERC-20 mint
          { block_number: 101, log_index: 0, topic1: pad(A), topic2: pad(B), topic3: pad(A), data: "0x" }, // ERC-721 Transfer: 3rd indexed topic (tokenId), empty data
          { block_number: 102, log_index: 0, topic1: pad(A), topic2: pad(B), data: "0x" + "11".repeat(5) }, // malformed: data not exactly 32 bytes
        ],
        [{ number: 100, timestamp: 100 }, { number: 101, timestamp: 101 }, { number: 102, timestamp: 102 }],
        200,
      )), { status: 200 });
    });
    const result = await fetchTransferHistory({ token: TOKEN, toBlock: 199, apiToken: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(result.transfers).toEqual([{ block: 100, logIndex: 0, timestamp: 100, from: ZERO, to: A, value: "1000" }]);
    expect(result.skipped).toBe(2);
  });

  // HyperSync's field_selection can return topic3 as an explicit null
  // (rather than simply omitting the key) for a log with no third indexed
  // topic. A valid ERC-20 Transfer log shaped that way must be decoded, not
  // treated as the ERC-721-shaped 3rd-topic case above.
  it("accepts a valid ERC-20 log whose topic3 is explicitly null", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(page(
        [{ block_number: 100, log_index: 0, topic1: pad(ZERO), topic2: pad(A), topic3: null, data: hex(1000n) }],
        [{ number: 100, timestamp: 100 }],
        200,
      )), { status: 200 });
    });
    const result = await fetchTransferHistory({ token: TOKEN, toBlock: 199, apiToken: "tok" }, fetchImpl as unknown as typeof fetch);
    expect(result.transfers).toEqual([{ block: 100, logIndex: 0, timestamp: 100, from: ZERO, to: A, value: "1000" }]);
    expect(result.skipped).toBe(0);
  });

  // A page that reports HTTP 200 but doesn't actually advance past its own
  // from_block (or lacks next_block/data entirely) must throw, not return a
  // truncated result that then gets cached as complete.
  it("throws when a page doesn't advance past its own from_block", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { from_block: number };
      return new Response(JSON.stringify(page([], [], req.from_block)), { status: 200 }); // next_block === from_block: no progress
    });
    // A stalled page is now retried (capped at MAX_OTHER_ATTEMPTS attempts --
    // unlike a 429, which is retryable but has no cap at all) rather than
    // thrown immediately, so this needs a tiny retryDelayMs to stay fast.
    await expect(
      fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1 }, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow();
  });
  it("throws when next_block is missing", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ logs: [], blocks: [] }], archive_height: 99_999_999 }), { status: 200 });
    });
    await expect(
      fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok" }, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow();
  });

  // Retries must also cover a rejected fetch (network error) and a
  // malformed JSON body, not just 429/5xx status codes.
  it("retries a rejected fetch (network error) then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    const result = await fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1 }, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(2);
    expect(result.transfers).toEqual([]);
  });
  it("retries a malformed JSON response then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response("not json", { status: 200 });
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    const result = await fetchTransferHistory({ token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1 }, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(2);
    expect(result.transfers).toEqual([]);
  });
  it("honours a Retry-After header instead of the exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n += 1;
        if (n === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "3" } });
        return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
      });
      // A tiny retryDelayMs would make the *unscaled* exponential backoff
      // resolve in ~1ms; Retry-After deliberately ignores that knob. random:
      // () => 0 also drops the pause-wait's own spread, so the total wait is
      // exactly the 3s header: still seeing no second call after 2999ms
      // proves the header, not the backoff or the spread, is what's waited on.
      const promise = fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, random: () => 0, pause: createRatePause() },
        fetchImpl as unknown as typeof fetch,
      );
      await vi.advanceTimersByTimeAsync(2999);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      expect(n).toBe(2);
      expect(result.transfers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A `Retry-After: 0` header used to pass straight through as a zero-length
  // wait (retryAfterMs only rejected negative values, and the 429 branch used
  // its result directly), so a server holding the limit open with `Retry-After:
  // 0` produced an immediate-retry loop for as long as the limit lasted. The
  // header is now a floor under the jittered backoff, never a replacement for it.
  it("waits more than zero when Retry-After is 0", async () => {
    let n = 0;
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    await fetchTransferHistory(
      { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, pause: createRatePause(), onRetry: (info) => waits.push(info.waitMs) },
      fetchImpl as unknown as typeof fetch,
    );
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  // A server that keeps answering the same small Retry-After forever must not
  // pin every retry to that value: the backoff still escalates underneath it,
  // and the header only raises the wait, never lowers it below that escalation.
  it("waits the escalated backoff once it exceeds a shorter Retry-After header", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const waits: number[] = [];
      const fetchImpl = vi.fn(async () => {
        n += 1;
        if (n <= 2) return new Response("slow down", { status: 429, headers: { "Retry-After": "1" } });
        return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
      });
      // random: () => 1 reproduces the un-jittered full backoff (1000ms, then
      // 2000ms) -- and the pause-wait's own full spread each time it waits --
      // so the second reported wait is deterministically 2000, past the
      // 1000ms header. Fake timers cost nothing in real test time, so 5000ms
      // is advanced to comfortably cover the spread on top of both waits.
      const promise = fetchTransferHistory(
        {
          token: TOKEN,
          toBlock: 99,
          apiToken: "tok",
          random: () => 1,
          pause: createRatePause(),
          onRetry: (info) => waits.push(info.waitMs),
        },
        fetchImpl as unknown as typeof fetch,
      );
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;
      expect(waits).toEqual([1000, 2000]);
      expect(result.transfers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Important 1 (review, fix round 1): the pause-wait used to check the
  // shared pause once, sleep once, then fetch unconditionally -- so if
  // another request's 429 (or this request's own next one) extended the
  // pause again while it slept, it fetched straight into the still-active
  // pause anyway. The wait is now a loop that re-checks after every sleep.
  it("re-checks the shared pause after every sleep, instead of fetching into one extended during its wait", async () => {
    vi.useFakeTimers();
    try {
      const pause = createRatePause();
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n += 1;
        if (n === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } });
        if (n === 2) return new Response("slow down", { status: 429, headers: { "Retry-After": "5" } });
        return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
      });
      // A: random: () => 0 -- its own 429 wait adds no spread, so its retry
      // lands exactly on the pause it just set. B: random: () => 0.5, so its
      // spread is visible and distinguishable from A's.
      const a = fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1000, pause, random: () => 0 },
        fetchImpl as unknown as typeof fetch,
      );
      await vi.advanceTimersByTimeAsync(0); // let A's own first fetch fire and set the pause to T+2000
      expect(n).toBe(1);
      const b = fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1000, pause, random: () => 0.5 },
        fetchImpl as unknown as typeof fetch,
      );
      await vi.advanceTimersByTimeAsync(2600);
      // By T+2600: A's own retry (at T+2000) already got a second 429
      // (Retry-After: 5), extending the pause to T+7000. B was due to wake at
      // T+2500 (2000 + its own 500ms spread), but must have re-checked the
      // now-later pause and gone back to sleep rather than fetching -- so
      // still only A's two calls have happened.
      expect(n).toBe(2);
      await vi.advanceTimersByTimeAsync(4400); // T+7000: A's own wait elapses
      expect(n).toBe(3);
      await vi.advanceTimersByTimeAsync(500); // T+7500: B's re-extended wait elapses
      await Promise.all([a, b]);
      expect(n).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // Minor 1 (review, fix round 1): a request used to sleep once for exactly
  // its own computed wait, then check the pause again with no spread of its
  // own added -- so, depending on sub-millisecond timing, it could either
  // slip through with no spread or add a whole extra one by chance (observed
  // 0.8-6.8% of the time with jitter's fractional-ms waits). Now the pause
  // recipient never sleeps directly: it always waits out the shared pause
  // through the same loop as everyone else, so it always adds its own spread
  // exactly once, deterministically.
  it("adds the waiting request's own spread on top of an already-set pause", async () => {
    vi.useFakeTimers();
    try {
      const pause = createRatePause();
      pause.pausedUntil = Date.now() + 1000; // as if another request's 429 already extended it
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n += 1;
        return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
      });
      // random: () => 0.5 with retryDelayMs: 1000 adds a 500ms spread on top
      // of the 1000ms remaining on the pause.
      const promise = fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1000, pause, random: () => 0.5 },
        fetchImpl as unknown as typeof fetch,
      );
      await vi.advanceTimersByTimeAsync(1400);
      expect(n).toBe(0); // short of pausedUntil (1000ms) + its own spread (500ms)
      await vi.advanceTimersByTimeAsync(100);
      await promise;
      expect(n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The pause is only ever raised, never overwritten: two requests racing a
  // 429 at once must leave the longer of their two waits in place, whichever
  // is processed last. A plain assignment instead of Math.max would let the
  // one processed second silently pull an already-longer pause back in.
  it("keeps the longer pause when two requests race a 429 at once (Math.max, not overwrite)", async () => {
    vi.useFakeTimers();
    try {
      const pause = createRatePause();
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n += 1;
        // First call (A, awaited first since it was invoked first): a long
        // wait. Second (B, awaited second): a short one, which must not
        // shrink what A just set.
        if (n === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "10" } });
        if (n === 2) return new Response("slow down", { status: 429, headers: { "Retry-After": "1" } });
        return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
      });
      const startedAt = Date.now();
      // Called back to back, with no await between: both reach their own
      // first fetch (each synchronously, before either yields) while the
      // pause is still unset, so this is a genuine race, not one request
      // waiting on the other's pause.
      const a = fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, pause, random: () => 0 },
        fetchImpl as unknown as typeof fetch,
      );
      const b = fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, pause, random: () => 0 },
        fetchImpl as unknown as typeof fetch,
      );
      await vi.advanceTimersByTimeAsync(0); // let both responses land and both 429s get processed
      expect(n).toBe(2);
      expect(pause.pausedUntil).toBe(startedAt + 10_000); // A's longer wait wins over B's shorter one
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([a, b]);
      expect(n).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // Every retryable-failure sleep is jittered ("equal jitter": half the raw
  // backoff, plus up to that same half again at random) so a batch of requests
  // hitting the same failure at once don't all retry in lockstep.
  it("jitters the backoff for a network-error retry", async () => {
    let n = 0;
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify(page([], [], 100)), { status: 200 });
    });
    await fetchTransferHistory(
      { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, random: () => 0.25, onRetry: (info) => waits.push(info.waitMs) },
      fetchImpl as unknown as typeof fetch,
    );
    // backoffMs(0, 1) = 1ms; jittered by random: () => 0.25 to 1/2 + 0.25*(1/2) = 0.625.
    expect(waits).toEqual([0.625]);
  });

  // The stalled-page retry in fetchPage shares the same jitter as postQuery's
  // own retries, rather than sleeping the raw, un-jittered backoff.
  it("jitters the backoff for a stalled-page retry", async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { from_block: number };
      return new Response(JSON.stringify(page([], [], req.from_block)), { status: 200 }); // never advances
    });
    await expect(
      fetchTransferHistory(
        { token: TOKEN, toBlock: 99, apiToken: "tok", retryDelayMs: 1, random: () => 0.25, onRetry: (info) => waits.push(info.waitMs) },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(waits[0]).toBe(0.625); // stall=0: backoffMs(0,1)=1ms, jittered the same way
  });

  // The whole pre-registration history used to be held in memory with no
  // bound at all. Any non-quote token paired with USDG or a stock is tracked
  // (anyone can pair a spam token that way), so a WETH- or USDC-shaped pool
  // would otherwise replay that asset's entire chain history and exhaust
  // memory, which repeats on every restart and halts the indexer for good.
  it("stops paging and returns capped: true once the transfer count would exceed maxTransfers", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(page(
        [
          { block_number: 100, log_index: 0, topic1: pad(ZERO), topic2: pad(A), data: hex(1n) },
          { block_number: 100, log_index: 1, topic1: pad(A), topic2: pad(B), data: hex(1n) },
          { block_number: 100, log_index: 2, topic1: pad(B), topic2: pad(A), data: hex(1n) },
        ],
        [{ number: 100, timestamp: 100 }],
        200,
      )), { status: 200 });
    });
    const result = await fetchTransferHistory(
      { token: TOKEN, toBlock: 199, apiToken: "tok", maxTransfers: 2 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ transfers: [], skipped: 0, capped: true });
  });

  it("does not cap a history at or under maxTransfers", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(page(
        [{ block_number: 100, log_index: 0, topic1: pad(ZERO), topic2: pad(A), data: hex(1n) }],
        [{ number: 100, timestamp: 100 }],
        200,
      )), { status: 200 });
    });
    const result = await fetchTransferHistory(
      { token: TOKEN, toBlock: 199, apiToken: "tok", maxTransfers: 1 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.capped).toBeUndefined();
    expect(result.transfers).toHaveLength(1);
  });
});
