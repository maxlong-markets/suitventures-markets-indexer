import denylistJson from "../../config/token-denylist.json" with { type: "json" };

type DenylistRow = { address: string; symbol: string; reason: string };

const DENYLISTED = new Set((denylistJson as DenylistRow[]).map((r) => r.address.toLowerCase()));

/**
 * True when `address` must never be tracked as a memestock token, however it's
 * paired. Any non-quote token can be paired with a quote (USDG, or a stock) by
 * anyone, so a spam token wrapping a real asset (a wrapped BTC such as cbBTC,
 * and TAO) would otherwise be indexed like a real memestock and would replay
 * that asset's entire chain history (see config/token-denylist.json, seeded by
 * scripts/build-quotes.ts).
 */
export function isDenylisted(address: string): boolean {
  return DENYLISTED.has(address.toLowerCase());
}
