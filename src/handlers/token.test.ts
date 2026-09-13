import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";

// Simulate items type their address-shaped fields (srcAddress, params.from/to)
// as the generated `Address` (`0x${string}`) rather than plain `string`, the
// same as Task 8's poolManager.test.ts helpers. These constants and the
// `transfer` helper below are typed `Address` so their values satisfy that
// requirement without changing any value.
const TOKEN: Address = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";

// Ruling 6: the test indexer's simulate source applies the same address gate a
// real source would — it only delivers a non-wildcard Token.Transfer for an
// address that a `contractRegister` has actually registered (confirmed: without
// this, every Transfer below comes back "never reached a handler"). Pair TOKEN
// with NVDA through a hookless PoolManager.Initialize at an earlier block so
// Task 8's `contractRegister` on PoolManager.Initialize (poolManager.ts) calls
// `context.chain.Token.add` before any Transfer for TOKEN is simulated. NVDA and
// the PoolManager address are Task 8's poolManager.test.ts constants; Initialize
// creates no balances, so it leaves every assertion below unchanged.
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const REGISTER_POOL = "0x" + "99".repeat(32);
const Q96 = 2n ** 96n;

function registerToken(block: number) {
  return {
    contract: "PoolManager" as const, event: "Initialize" as const, srcAddress: POOL_MANAGER,
    block: { number: block, timestamp: 1_700_000_000 + block },
    params: {
      id: REGISTER_POOL, currency0: TOKEN, currency1: NVDA, fee: 8388608n, tickSpacing: 8n,
      hooks: ZERO, sqrtPriceX96: Q96, tick: 0n,
    },
  };
}

function transfer(from: Address, to: Address, value: bigint, block: number) {
  return {
    contract: "Token" as const, event: "Transfer" as const, srcAddress: TOKEN,
    block: { number: block, timestamp: 1_700_000_000 + block },
    params: { from, to, value },
  };
}

describe("Token Transfer", () => {
  it("mints raise supply and create a holder", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [registerToken(0), transfer(ZERO, A, 1000n, 1)] } } });
    const token = await indexer.Token.getOrThrow(TOKEN.toLowerCase());
    t.expect(token.totalSupply).toBe(1000n);
    t.expect(token.holdersCount).toBe(1);
    t.expect(token.metadataLoaded).toBe(false);
    const bal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${A}`);
    t.expect(bal.balance).toBe(1000n);
  });
  it("counts holders on zero crossings only", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      registerToken(0),
      transfer(ZERO, A, 1000n, 1),
      transfer(A, B, 400n, 2),     // A stays a holder, B becomes one
      transfer(A, B, 600n, 3),     // A drops to zero
      transfer(B, ZERO, 1000n, 4), // burn everything
    ] } } });
    const token = await indexer.Token.getOrThrow(TOKEN.toLowerCase());
    t.expect(token.totalSupply).toBe(0n);
    t.expect(token.holdersCount).toBe(0);
  });
  it("never counts address zero as a holder", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [registerToken(0), transfer(ZERO, A, 5n, 1), transfer(A, ZERO, 5n, 2)] } } });
    t.expect(await indexer.TokenBalance.get(`${TOKEN.toLowerCase()}-${ZERO}`)).toBeUndefined();
  });
});
