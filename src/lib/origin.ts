import curated from "../../config/curated-pools.json" with { type: "json" };
import { DOPPLER_HOOK, PONS_MEME_HOOK, ZERO_ADDRESS } from "./constants";

export type Origin = "LONG" | "Pons" | "Uniswap" | "Other" | "SUIT" | "SV";

const CURATED = new Map<string, Origin>(
  Object.entries(curated as Record<string, Origin>).map(([id, o]) => [id.toLowerCase(), o]),
);

/** Origin is a label only: hook address, or the curated override. Never a gate. */
export function originFor(poolId: string, hooks: string): Origin {
  const override = CURATED.get(poolId.toLowerCase());
  if (override) return override;
  const h = hooks.toLowerCase();
  if (h === DOPPLER_HOOK) return "LONG";
  if (h === PONS_MEME_HOOK) return "Pons";
  if (h === ZERO_ADDRESS) return "Uniswap";
  return "Other";
}
