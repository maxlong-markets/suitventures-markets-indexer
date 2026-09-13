import { describe, it, beforeEach, afterEach, vi } from "vitest";
import { createTestIndexer, type Address } from "envio";

// Simulate items type their address-shaped fields (srcAddress, params.from/to/
// currency0/currency1/hooks) as the generated `Address` (`0x${string}`) rather
// than plain `string`, the same as Task 8/9's handler tests. These constants
// are typed `Address` so their values satisfy that requirement without
// changing any value; POOL (a bytes32 pool id, not an address) stays a plain
// string, matching the existing poolManager.test.ts convention.
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const TOKEN: Address = "0xc9e9ab90654f82893d7fd18b62f694992e8cef29";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const PONS: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const POOL = "0x6eb457f0729bd458608099505990f03d8a6af91202f936124f72ad76c96f6fe1";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";
const pad = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2).toLowerCase();
const hex = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const Q96 = 2n ** 96n;
const INIT_BLOCK = 27_828_161;

function init() {
  return {
    contract: "PoolManager" as const, event: "Initialize" as const, srcAddress: POOL_MANAGER,
    block: { number: INIT_BLOCK, timestamp: 1_757_000_000 },
    params: { id: POOL, currency0: TOKEN, currency1: NVDA, fee: 0n, tickSpacing: 200n, hooks: PONS, sqrtPriceX96: Q96, tick: 0n },
  };
}
function transfer(from: Address, to: Address, value: bigint, block: number) {
  return {
    contract: "Token" as const, event: "Transfer" as const, srcAddress: TOKEN,
    block: { number: block, timestamp: 1_757_000_000 + block - INIT_BLOCK },
    params: { from, to, value },
  };
}

const historyPage = {
  data: [{
    blocks: [{ number: 27_823_666, timestamp: 1_756_990_000 }, { number: 27_823_700, timestamp: 1_756_990_100 }],
    logs: [
      { block_number: 27_823_666, log_index: 0, topic1: pad(ZERO), topic2: pad(A), data: hex(1_000n) },
      { block_number: 27_823_700, log_index: 2, topic1: pad(A), topic2: pad(B), data: hex(400n) },
    ],
  }],
  next_block: INIT_BLOCK,
  archive_height: 99_999_999,
};

describe("pre-registration transfer history", () => {
  const bodies: string[] = [];
  beforeEach(() => {
    process.env.ENVIO_API_TOKEN = "test-token";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify(historyPage), { status: 200 });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ENVIO_API_TOKEN;
    bodies.length = 0;
  });

  it("replays transfers before the registration block, then keeps counting live ones", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      init(),
      transfer(B, ZERO, 100n, INIT_BLOCK + 1), // live burn after registration
    ] } } });
    const token = await indexer.Token.getOrThrow(TOKEN);
    t.expect(token.historyLoaded).toBe(true);
    t.expect(token.totalSupply).toBe(900n);     // 1000 minted, 100 burned
    t.expect(token.holdersCount).toBe(2);       // A (600) and B (300)
    t.expect((await indexer.TokenBalance.getOrThrow(`${TOKEN}-${A}`)).balance).toBe(600n);
    t.expect((await indexer.TokenBalance.getOrThrow(`${TOKEN}-${B}`)).balance).toBe(300n);
    const body = JSON.parse(bodies[0]!);
    t.expect(body.to_block).toBe(INIT_BLOCK); // exclusive: everything before the registration block
    t.expect(body.logs[0].address).toEqual([TOKEN]);
  });

  it("does not replay twice when a second pool appears", async (t) => {
    const indexer = createTestIndexer();
    const second = { ...init(), params: { ...init().params, id: "0x" + "44".repeat(32), hooks: ZERO }, block: { number: INIT_BLOCK + 5, timestamp: 1_757_000_005 } };
    await indexer.process({ chains: { 4663: { simulate: [init(), second] } } });
    const token = await indexer.Token.getOrThrow(TOKEN);
    t.expect(token.totalSupply).toBe(1_000n);
    t.expect(token.poolCount).toBe(2);
    // Both Initialize events sit in one batch, so envio's preload pass (see
    // EventProcessing.res `preloadBatchOrThrow`, which runs every handler in
    // the batch concurrently, isPreload: true, before the sequential commit
    // pass applies any writes) sees historyLoaded: false for both and
    // speculatively calls the effect for each event's own toBlock. The
    // committed run still only applies the replay once — proven by
    // totalSupply staying 1_000n above instead of doubling to 2_000n — so
    // bodies is not evidence of a double-apply, only of preload's extra
    // (harmless) network calls; it can be more than 1, never 0.
    t.expect(bodies.length).toBeGreaterThanOrEqual(1);
  });

  it("skips the replay without an API token", async (t) => {
    delete process.env.ENVIO_API_TOKEN;
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [init()] } } });
    const token = await indexer.Token.getOrThrow(TOKEN);
    t.expect(token.historyLoaded).toBe(true);
    t.expect(token.totalSupply).toBe(0n);
    t.expect(bodies).toHaveLength(0);
  });
});
