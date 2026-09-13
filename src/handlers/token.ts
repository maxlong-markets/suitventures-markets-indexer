import { indexer, type TokenBalance } from "envio";
import { ZERO_ADDRESS } from "../lib/constants";
import { ensureToken } from "./shared";

indexer.onEvent({ contract: "Token", event: "Transfer", fields: { block: ["timestamp"] } }, async ({ event, context }) => {
  const ts = event.block.timestamp;
  const token = await ensureToken(context, event.srcAddress, ts);
  const from = event.params.from.toLowerCase();
  const to = event.params.to.toLowerCase();
  const value = event.params.value;
  if (from === to) return; // self-transfer: nothing moves
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
    const row: TokenBalance = { id, token_id: token.id, holder: from, balance: after, updatedAt: ts };
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
    const row: TokenBalance = { id, token_id: token.id, holder: to, balance: after, updatedAt: ts };
    context.TokenBalance.set(row);
  }

  if (holdersDelta !== 0 || supplyDelta !== 0n) {
    context.Token.set({
      ...token,
      holdersCount: token.holdersCount + holdersDelta,
      totalSupply: token.totalSupply + supplyDelta,
    });
  }
});
