import curated from "../../config/curated-pools.json" with { type: "json" };
import { DOPPLER_HOOK, PONS_MEME_HOOK, ZERO_ADDRESS } from "./constants";

export type Origin = "LONG" | "Pons" | "Uniswap" | "Other" | "SUIT" | "SV";

const VALID_ORIGINS: ReadonlySet<string> = new Set<Origin>(["LONG", "Pons", "Uniswap", "Other", "SUIT", "SV"]);

/**
 * Throws when a curated override names a value outside the Origin enum: a
 * typo there would otherwise sit in a Token/Pool row that the generated
 * GraphQL schema can't even encode, surfacing as an opaque error far from
 * the actual mistake.
 */
export function validateCurated(map: Record<string, string>): void {
  for (const [id, value] of Object.entries(map)) {
    if (!VALID_ORIGINS.has(value)) {
      throw new Error(`config/curated-pools.json: ${id} has an invalid origin ${JSON.stringify(value)}`);
    }
  }
}
validateCurated(curated as Record<string, string>);

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
