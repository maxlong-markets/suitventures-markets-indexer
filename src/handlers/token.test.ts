import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";

// Simulate items type their address-shaped fields (srcAddress, params.from/to)
// as the generated `Address` (`0x${string}`) rather than plain `string`, the
// same convention as poolManager.test.ts's helpers. These constants and the
// `transfer` helper below are typed `Address` so their values satisfy that
// requirement without changing any value.
const TOKEN: Address = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";
const C: Address = "0x3333333333333333333333333333333333333333";
const D: Address = "0x4444444444444444444444444444444444444444";
// Mixed-case, 40 hex chars: exercises the `.toLowerCase()` on TokenBalance ids
// without being confused for one of the all-lowercase constants above.
const MIXED = ("0xAbCd" + "0".repeat(35) + "1") as Address;

// The test indexer's simulate source applies the same address gate a real
// source would — it only delivers a non-wildcard Token.Transfer for an
// address that a `contractRegister` has actually registered (confirmed: without
// this, every Transfer below comes back "never reached a handler"). Pair TOKEN
// with NVDA through a hookless PoolManager.Initialize at an earlier block so
// poolManager.ts's `contractRegister` on PoolManager.Initialize calls
// `context.chain.Token.add` before any Transfer for TOKEN is simulated. NVDA and
// the PoolManager address are poolManager.test.ts's own constants. Initialize
// itself creates the Token row (via `ensureToken`) that the Transfer handler
// below then updates; it creates no balances, so it leaves every balance
// assertion below unchanged.
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const REGISTER_POOL = "0x" + "99".repeat(32);
const Q96 = 2n ** 96n;

function registerToken(block: number) {
  return {
    contract: "PoolManager" as const, event: "Initialize" as const, srcAddress: POOL_MANAGER,
    block: { number: block, timestamp: 1_700_000_000 + block },
    params: {
      // Static 0.3% fee: a hookless pool (hooks: ZERO below) can't use the
      // dynamic-fee flag (8388608n), which requires a hook to set the fee.
      id: REGISTER_POOL, currency0: TOKEN, currency1: NVDA, fee: 3000n, tickSpacing: 8n,
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
    t.expect(token.poolCount).toBe(1);
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

  // Guard tests written against the pre-refactor handler, kept passing
  // across the `applyTransfer` extraction.
  it("lowercases a mixed-case holder's balance id", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      registerToken(0),
      transfer(ZERO, MIXED, 10n, 1),
      transfer(MIXED, B, 10n, 2),
      transfer(B, MIXED, 4n, 3),
    ] } } });
    const token = await indexer.Token.getOrThrow(TOKEN.toLowerCase());
    t.expect(token.holdersCount).toBe(2);
    t.expect(token.totalSupply).toBe(10n);
    const mixedBal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${MIXED.toLowerCase()}`);
    t.expect(mixedBal.balance).toBe(4n);
    const bBal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${B}`);
    t.expect(bBal.balance).toBe(6n);
  });

  it("leaves balance and holder count unchanged on a self-transfer", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      registerToken(0),
      transfer(ZERO, A, 5n, 1),
      transfer(A, A, 5n, 2),
    ] } } });
    const token = await indexer.Token.getOrThrow(TOKEN.toLowerCase());
    t.expect(token.holdersCount).toBe(1);
    t.expect(token.totalSupply).toBe(5n);
    const aBal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${A}`);
    t.expect(aBal.balance).toBe(5n);
    t.expect(aBal.updatedAt).toBe(transfer(ZERO, A, 5n, 1).block.timestamp); // self-transfer at block 2 touched nothing
  });

  it("lets a sender with no recorded history go negative", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      registerToken(0),
      transfer(C, A, 3n, 1),
    ] } } });
    const token = await indexer.Token.getOrThrow(TOKEN.toLowerCase());
    t.expect(token.holdersCount).toBe(1);
    const cBal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${C}`);
    t.expect(cBal.balance).toBe(-3n);
    const aBal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${A}`);
    t.expect(aBal.balance).toBe(3n);
  });

  // The registration gate above is block-aware, not positional — a
  // same-block Transfer ahead of its registering Initialize is delivered
  // fine at a non-zero block; an earlier version of this test rejected it
  // only because that probe was specific to block 0.
  it("keeps a same-block mint that precedes the registering Initialize", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      transfer(ZERO, A, 1000n, 10),
      registerToken(10),
    ] } } });
    const token = await indexer.Token.getOrThrow(TOKEN.toLowerCase());
    t.expect(token.totalSupply).toBe(1000n);
    t.expect(token.poolCount).toBe(1);
    t.expect(token.holdersCount).toBe(1);
    const aBal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${A}`);
    t.expect(aBal.balance).toBe(1000n);
    t.expect(token.createdAt).toBe(transfer(ZERO, A, 1000n, 10).block.timestamp);
  });

  // Written to fail against the pre-refactor handler (it wrote a
  // zero-balance row for D instead of skipping entirely), then made to pass
  // by the zero-value check in `applyTransfer`.
  it("writes nothing for a zero-value transfer", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      registerToken(0),
      transfer(ZERO, A, 5n, 1),
      transfer(A, D, 0n, 2),
    ] } } });
    const token = await indexer.Token.getOrThrow(TOKEN.toLowerCase());
    t.expect(token.holdersCount).toBe(1);
    t.expect(await indexer.TokenBalance.get(`${TOKEN.toLowerCase()}-${D}`)).toBeUndefined();
    const aBal = await indexer.TokenBalance.getOrThrow(`${TOKEN.toLowerCase()}-${A}`);
    t.expect(aBal.balance).toBe(5n);
    t.expect(aBal.updatedAt).toBe(transfer(ZERO, A, 5n, 1).block.timestamp); // zero-value transfer at block 2 touched nothing
  });
});
