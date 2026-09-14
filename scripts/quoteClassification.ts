// Pure, dependency-free: decides whether a token belongs in the quote
// allowlist (config/quotes.json, written by build-quotes.ts) or the
// pairing-asset denylist (config/token-denylist.json), and fails loudly if a
// token's on-chain name() disagrees with what its symbol implies, instead of
// silently writing a miscategorized token. Symbol alone decided this before;
// a symbol collision is how three real Robinhood stock tokens (WYFI, SKHY,
// BULL) ended up excluded with no error at all.

export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

// Crypto or wrapped assets that Pons accepts as quotes, not Robinhood stock
// tokens. Matched case-insensitively: an on-chain symbol()'s exact casing
// isn't guaranteed to match how it's written here.
export const EXCLUDED_SYMBOLS = new Set(["WETH", "ETH", "cbBTC", "TAO"].map((s) => s.toUpperCase()));

const ROBINHOOD_SUFFIX = "Robinhood Token";

export type QuoteClassification = "quote" | "excluded";

/**
 * "quote": belongs in config/quotes.json (USDG, or a Robinhood stock token).
 * "excluded": belongs in config/token-denylist.json (a crypto/wrapped
 * pairing asset such as WETH or cbBTC). USDG is always "quote", checked
 * before -- and instead of -- the name cross-check below, since USDG is not
 * itself a Robinhood stock token. Otherwise, a token whose symbol is in
 * EXCLUDED_SYMBOLS is "excluded"; every other token is "quote". Either way,
 * `name` must agree with that: throws, naming the token, when a "quote"
 * token's name does not end with "Robinhood Token", or when an "excluded"
 * token's name does end with it.
 */
export function classifyQuoteToken(address: string, symbol: string, name: string): QuoteClassification {
  if (address.toLowerCase() === USDG) return "quote";
  const excluded = EXCLUDED_SYMBOLS.has(symbol.toUpperCase());
  const isRobinhoodStock = name.endsWith(ROBINHOOD_SUFFIX);
  if (!excluded && !isRobinhoodStock) {
    throw new Error(`${address} (${symbol}): expected a Robinhood stock token, but name "${name}" does not end with "${ROBINHOOD_SUFFIX}"`);
  }
  if (excluded && isRobinhoodStock) {
    throw new Error(`${address} (${symbol}): excluded by symbol, but name "${name}" ends with "${ROBINHOOD_SUFFIX}" like a Robinhood stock token`);
  }
  return excluded ? "excluded" : "quote";
}
