import { indexer, type Token, type TokenBalance } from "envio";
import { ZERO_ADDRESS } from "../lib/constants";
import { ensureToken, type HandlerContext } from "./shared";

/**
 * Moves `value` from `from` to `to` in TokenBalance and returns the token with
 * holdersCount/totalSupply updated (the caller persists it). Holders change only on
 * zero crossings; address zero is mint/burn and never a holder.
 */
export async function applyTransfer(
  context: HandlerContext,
  token: Token,
  from: string,
  to: string,
  value: bigint,
  timestamp: number,
): Promise<Token> {
  if (from === to) return token; // self-transfer: nothing moves
  if (value === 0n) return token; // zero-value transfer: nothing moves, no rows written
  let holdersDelta = 0;
  let supplyDelta = 0n;

  if (from === ZERO_ADDRESS) {
    supplyDelta += value;
  } else {
    const id = `${token.id}-${from}`;
    const bal = await context.TokenBalance.get(id);
    const before = bal?.balance ?? 0n;
    const after = before - value;
    if (before > 0n && after <= 0n) holdersDelta -= 1;
    const row: TokenBalance = { id, token_id: token.id, holder: from, balance: after, updatedAt: timestamp };
    context.TokenBalance.set(row);
  }

  if (to === ZERO_ADDRESS) {
    supplyDelta -= value;
  } else {
    const id = `${token.id}-${to}`;
    const bal = await context.TokenBalance.get(id);
    const before = bal?.balance ?? 0n;
    const after = before + value;
    if (before <= 0n && after > 0n) holdersDelta += 1;
    const row: TokenBalance = { id, token_id: token.id, holder: to, balance: after, updatedAt: timestamp };
    context.TokenBalance.set(row);
  }

  if (holdersDelta === 0 && supplyDelta === 0n) return token;
  return { ...token, holdersCount: token.holdersCount + holdersDelta, totalSupply: token.totalSupply + supplyDelta };
}

indexer.onEvent({ contract: "Token", event: "Transfer", fields: { block: ["timestamp"] } }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const token = await ensureToken(context, event.srcAddress, ts);
  const updated = await applyTransfer(
    context,
    token,
    event.params.from.toLowerCase(),
    event.params.to.toLowerCase(),
    event.params.value,
    ts,
  );
  if (updated !== token) context.Token.set(updated);
});
