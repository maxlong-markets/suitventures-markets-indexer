import { indexer, type Pool, type Swap, type Candle, type Address } from "envio";
import { isQuote, QUOTE_ADDRESSES } from "../lib/quotes";
import { originFor } from "../lib/origin";
import { priceFromSqrtPriceX96, toUnits, absBig } from "../lib/price";
import { INTERVALS, bucketStart, candleId, candleWindowAllows } from "../lib/candles";
import { amountsForLiquidityDelta } from "../lib/liquidity";
import { getTokenMetadata } from "../effects/tokenMetadata";
import { getTransferHistory } from "../effects/transferHistory";
import { ZERO_ADDRESS } from "../lib/constants";
import { ensureQuote, ensureToken, recomputePrimaryPool, type HandlerContext } from "./shared";
import { applyTransfer } from "./token";

// The generated `where` filter narrows params to `Address` (a `0x${string}` template
// literal), but `QUOTE_ADDRESSES` is plain `string[]` since it's also compared with
// case-insensitive helpers elsewhere. Every entry is already a lowercase 0x address
// (config/quotes.json), so this cast only narrows the static type, without changing
// any value.
const QUOTE_ADDRESSES_FILTER = QUOTE_ADDRESSES as Address[];

// HyperSync only sends Initialize logs where one of the indexed sides is a quote.
const INITIALIZE = {
  contract: "PoolManager",
  event: "Initialize",
  where: { params: [{ currency0: QUOTE_ADDRESSES_FILTER }, { currency1: QUOTE_ADDRESSES_FILTER }] },
} as const;

function classify(currency0: Address, currency1: Address) {
  const q0 = isQuote(currency0);
  const q1 = isQuote(currency1);
  if (q0 === q1) return null; // both quotes or neither: not a memestock pool
  const token = q1 ? currency0 : currency1;
  const quote = q1 ? currency1 : currency0;
  // Native ETH (currency == address(0)) has no ERC-20 contract to register or
  // read metadata from, and ETH pools are deferred by README D22.
  if (token.toLowerCase() === ZERO_ADDRESS) return null;
  return { token, quote, tokenIsCurrency0: q1 };
}

indexer.contractRegister(INITIALIZE, async ({ event, context }) => {
  const c = classify(event.params.currency0, event.params.currency1);
  if (c) context.chain.Token.add(c.token);
});

indexer.onEvent({ ...INITIALIZE, fields: { block: ["timestamp"] } }, async ({ event, context }) => {
  const c = classify(event.params.currency0, event.params.currency1);
  if (!c) return;
  const poolId = event.params.id.toLowerCase();
  const ts = event.block.timestamp;
  const quote = await ensureQuote(context, c.quote, ts);
  let token = await ensureToken(context, c.token, ts);
  if (!token.metadataLoaded) {
    const meta = await context.effect(getTokenMetadata, c.token);
    token = { ...token, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, metadataLoaded: meta.ok };
  }
  if (!token.historyLoaded) {
    // Envio delivers this token's Transfer logs only from this block on (registration block,
    // same-block coverage). Everything earlier — the mint, launchpad-curve trades — is replayed here.
    const history = await context.effect(getTransferHistory, { token: c.token, toBlock: event.block.number - 1 });
    for (const h of history) {
      token = await applyTransfer(context, token, h.from, h.to, BigInt(h.value), h.timestamp || ts);
    }
    token = { ...token, historyLoaded: true };
  }
  const dec0 = c.tokenIsCurrency0 ? token.decimals : quote.decimals;
  const dec1 = c.tokenIsCurrency0 ? quote.decimals : token.decimals;
  const origin = originFor(poolId, event.params.hooks);
  const pool: Pool = {
    id: poolId,
    token_id: token.id,
    quote_id: quote.id,
    tokenIsCurrency0: c.tokenIsCurrency0,
    hooks: event.params.hooks.toLowerCase(),
    fee: Number(event.params.fee),
    tickSpacing: Number(event.params.tickSpacing),
    origin,
    createdAt: ts,
    priceQuote: priceFromSqrtPriceX96(event.params.sqrtPriceX96, dec0, dec1, c.tokenIsCurrency0),
    sqrtPriceX96: event.params.sqrtPriceX96,
    tvlToken: 0n,
    tvlQuote: 0n,
    swapCount: 0,
    lastSwapAt: undefined,
    volumeQuoteAllTime: 0,
  };
  context.Pool.set(pool);
  const poolCount = token.poolCount + 1;
  context.Token.set({
    ...token,
    poolCount,
    primaryPool_id: token.primaryPool_id ?? poolId,
    origin: token.primaryPool_id ? token.origin : origin,
  });
  if (poolCount > 1) await recomputePrimaryPool(context, token.id);
});

function updateCandles(
  context: HandlerContext,
  poolId: string,
  prevPrice: number,
  price: number,
  amountQuote: number,
  amountToken: number,
  timestamp: number,
  blockNumber: number,
): Promise<void>[] {
  return INTERVALS.filter((iv) => candleWindowAllows(iv, blockNumber)).map(async (interval) => {
    const t = bucketStart(timestamp, interval);
    const id = candleId(poolId, interval, t);
    const existing = await context.Candle.get(id);
    if (existing) {
      context.Candle.set({
        ...existing,
        high: Math.max(existing.high, price),
        low: Math.min(existing.low, price),
        close: price,
        volumeQuote: existing.volumeQuote + amountQuote,
        volumeToken: existing.volumeToken + amountToken,
        trades: existing.trades + 1,
      });
    } else {
      // Gapless: a bucket after a gap opens at the previous pool price.
      const candle: Candle = {
        id, pool_id: poolId, interval, t,
        open: prevPrice, high: Math.max(prevPrice, price), low: Math.min(prevPrice, price), close: price,
        volumeQuote: amountQuote, volumeToken: amountToken, trades: 1,
      };
      context.Candle.set(candle);
    }
  });
}

// v4 swap fees (LP plus protocol fee, `feePips` in pips) never become pool liquidity:
// they accrue to fee growth, and LPs collect them later through separate modifyLiquidity
// calls whose events carry no fee amount at all. So the side the swapper paid (a negative
// delta, meaning the pool's balance grows) grows only by its net-of-fee amount; the side
// the swapper received (a positive delta, meaning the pool's balance shrinks) shrinks by
// the full amount, since that side actually left the pool's reserves.
function principalDelta(delta: bigint, feePips: bigint): bigint {
  return delta < 0n ? (delta * (1_000_000n - feePips)) / 1_000_000n : delta;
}

indexer.onEvent(
  { contract: "PoolManager", event: "Swap", fields: { block: ["timestamp"], transaction: ["hash", "from"] } },
  async ({ event, context }) => {
    const pool = await context.Pool.get(event.params.id.toLowerCase());
    if (!pool) return; // untracked pool
    if (event.params.amount0 === 0n && event.params.amount1 === 0n) return; // no-op swap
    const token = await context.Token.getOrThrow(pool.token_id);
    const quote = await context.Quote.getOrThrow(pool.quote_id);
    // Swap amounts are the swapper's deltas, emitted before afterSwap: they are pre-hook-fee.
    const tokenDelta = pool.tokenIsCurrency0 ? event.params.amount0 : event.params.amount1;
    const quoteDelta = pool.tokenIsCurrency0 ? event.params.amount1 : event.params.amount0;
    const amountToken = toUnits(absBig(tokenDelta), token.decimals);
    const amountQuote = toUnits(absBig(quoteDelta), quote.decimals);
    const dec0 = pool.tokenIsCurrency0 ? token.decimals : quote.decimals;
    const dec1 = pool.tokenIsCurrency0 ? quote.decimals : token.decimals;
    const price = priceFromSqrtPriceX96(event.params.sqrtPriceX96, dec0, dec1, pool.tokenIsCurrency0);
    const ts = event.block.timestamp;

    const swap: Swap = {
      id: `${event.transaction.hash}-${event.logIndex}`,
      pool_id: pool.id,
      token_id: token.id,
      timestamp: ts,
      side: tokenDelta > 0n ? "buy" : "sell",
      amountToken,
      amountQuote,
      priceQuote: amountToken > 0 ? amountQuote / amountToken : price,
      // `from` is typed `Address | undefined` at the protocol level, but every real
      // transaction that emits a Swap has a sender; asserted, not guarded, to match.
      wallet: event.transaction.from!.toLowerCase(),
      txHash: event.transaction.hash,
    };
    context.Swap.set(swap);

    await Promise.all(updateCandles(context, pool.id, pool.priceQuote, price, amountQuote, amountToken, ts, event.block.number));

    context.Pool.set({
      ...pool,
      priceQuote: price,
      sqrtPriceX96: event.params.sqrtPriceX96,
      // TVL tracks principal liquidity only, net of the swap fee (see principalDelta above).
      tvlToken: pool.tvlToken === undefined ? undefined : pool.tvlToken - principalDelta(tokenDelta, event.params.fee),
      tvlQuote: pool.tvlQuote === undefined ? undefined : pool.tvlQuote - principalDelta(quoteDelta, event.params.fee),
      swapCount: pool.swapCount + 1,
      lastSwapAt: ts,
      volumeQuoteAllTime: pool.volumeQuoteAllTime + amountQuote,
    });
    if (token.poolCount > 1) await recomputePrimaryPool(context, token.id);
  },
);

indexer.onEvent({ contract: "PoolManager", event: "ModifyLiquidity" }, async ({ event, context }) => {
  const pool = await context.Pool.get(event.params.id.toLowerCase());
  if (!pool || pool.tvlToken === undefined || pool.tvlQuote === undefined) return;
  const { amount0, amount1 } = amountsForLiquidityDelta(
    pool.sqrtPriceX96,
    Number(event.params.tickLower),
    Number(event.params.tickUpper),
    event.params.liquidityDelta,
  );
  const tokenAmt = pool.tokenIsCurrency0 ? amount0 : amount1;
  const quoteAmt = pool.tokenIsCurrency0 ? amount1 : amount0;
  context.Pool.set({ ...pool, tvlToken: pool.tvlToken + tokenAmt, tvlQuote: pool.tvlQuote + quoteAmt });
  const token = await context.Token.getOrThrow(pool.token_id);
  if (token.poolCount > 1) await recomputePrimaryPool(context, token.id);
});

// No Donate handler: v4 donations accrue to fee growth like swap fees do, not to
// principal liquidity, so they must not be added to tvlToken/tvlQuote either.
