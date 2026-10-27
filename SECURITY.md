# Security review: suitventures-markets-indexer (legacy)

Status: this repository is decommissioned (21 Sep 2026) and is **not deployed**. It was reviewed on 27 Oct 2026 as a
legacy artefact, so that a reader can judge the code that was once run and the care taken with untrusted input. The
live system uses the chain reader in
[`src/lib/chain/`](https://github.com/maxlong-markets/suitventures-markets-frontend) of the frontend repo, which has
its own review. Not audited by a third party.

## Scope

- Read: every non-test file in `src/` (handlers, effects, lib), all of `scripts/`, `config.yaml`, `schema.graphql`,
  `config/*.json`, `.github/workflows/test.yaml`, `.gitignore`, `.env.example`.
- Ran: `npm test` (offline: 160 passed, 1 skipped live test, 18 files; the first cold run had 6 timeouts, see L-1),
  `npm run typecheck` (clean), `npm audit --omit=dev` (12 findings, see L-3), a grep of tracked files for keys,
  tokens and RPC URLs with embedded keys (none found; `.env` is git-ignored and was not read).
- Not run: `test:live` (needs network and credentials), a real sync.

## Threat model

- Assets: the HyperSync API token and the keyed RPC URL (both paid credentials); the integrity of the indexed
  prices, supply and holder counts.
- Actors: anyone who can deploy an ERC-20 and pair it with an allowlisted quote in a Uniswap v4 pool (a hostile
  token contract: reverting or garbage `name/symbol/decimals`, huge strings, a Transfer topic reused by an ERC-721,
  an old real asset wrapped to force a huge replay); a hostile or faulty HyperSync or RPC endpoint; the developer
  running the scripts.
- Trust boundaries: chain data and token contracts are untrusted; `config/*.json` and `data/*.json` are trusted repo
  content; HyperSync and the RPC are trusted for availability but their payloads are validated.
- No inbound network surface of its own: the indexer exposes only what Envio Cloud serves (read-only GraphQL).

## Controls in place

| Control | Where | Prevents |
|---|---|---|
| Refuses to start without credentials | `src/effects/transferHistory.ts:11`, `src/effects/tokenMetadata.ts:25`; proven by `src/effects/envGuard.test.ts` (spawns a real process) | Silent degradation: empty history marked loaded, placeholder metadata for every token |
| HyperSync URL fixed, token in a header | `HYPERSYNC_URL` and `postQuery` in `src/lib/hypersync.ts` (`Authorization: Bearer`) | Token in URLs and logs; request redirection |
| Logs never carry the token or RPC URL | `onRetry` logging in `transferHistory.ts`; `describeError` in `tokenMetadata.ts` uses `shortMessage` | Alchemy-style keys leaking from viem error messages |
| Bounded paging and replay size | `maxTransfers` (100,000) in `fetchTransferHistory`; stall detection in `fetchPage` (10 attempts) | A spam token wrapping an old asset exhausting memory; an endless loop on a lagging node |
| Non-ERC-20 logs skipped | `isErc20TransferLog` (two indexed topics, 32-byte data) | ERC-721 `Transfer` decoding throwing or producing wrong values |
| Malformed responses throw, not truncate | `fetchPage` shape check | A truncated history cached as complete |
| Retry policy | `postQuery`: 429 backs off with jitter and a shared pause, 5xx capped at 10, other 4xx not retried | Hammering a rate-limited API |
| Metadata hardening | `readTokenMetadata`, `validate`, `capCodePoints` in `tokenMetadata.ts`: symbol 32 and name 128 code points, NULs stripped, decimals 0-255, bytes32 fallback, a revert gives a non-cached fallback | Huge or hostile strings, a lone surrogate failing a Postgres jsonb write, a poisoned cache |
| Metadata read rate limit | `rateLimit: 10/s` on `getTokenMetadata` | RPC bans from bursts |
| Config validated at load | `validateQuotes` in `src/lib/quotes.ts` (duplicates, decimals, one-sided Chainlink pairing, USDG row) | A malformed allowlist producing wrong prices |
| Denylist | `src/lib/denylist.ts`, `config/token-denylist.json` | Wrapped real assets (cbBTC, TAO) paired with a quote being tracked as memestocks |
| One-allowlisted-side rule | `src/lib/primaryPool.ts`, `src/handlers/poolManager.ts` | Arbitrary pools being indexed |
| Scripts | `scripts/*.ts`: no `eval`, no shell-outs, no `fetch`; only `writeFileSync` to `config/*.json` with fixed paths | Command injection, path traversal |
| Secrets hygiene | `.gitignore` ignores `.env*` except `.env.example`; the example holds empty values | Committed credentials |
| CI least privilege | `.github/workflows/test.yaml`: `contents: read`, no secrets, no network tests | A compromised PR reaching credentials |

## Findings

| ID | Severity | Title | Where | What could go wrong | Status |
|---|---|---|---|---|---|
| L-1 | Low | Env-guard test can time out under load | `src/effects/envGuard.test.ts` (15 s `spawnSync` timeout) | On a cold, loaded run the four spawned-process tests timed out (6 failures in the first run); the rerun was green in 9.5 s. A flaky test, not a product defect | Open: raise the timeout; not changed because the repo is retired |
| L-2 | Low | No per-request timeout on the HyperSync `fetch` | `postQuery` in `src/lib/hypersync.ts` | A connection that never answers would stall one effect call; the 429 path also retries without a cap by design | Accepted: the chain reader that replaced this adds explicit timeouts |
| L-3 | Dependency audit (1 critical, 6 high, 1 moderate, 4 low) | `npm audit --omit=dev`: 12 findings | `envio@3.10.0` transitive (`express`, `body-parser`, `path-to-regexp`, `proxy-addr`, `ws`, an older bundled `viem`), plus `esbuild` | These sit in Envio's own server stack, not in code this repo calls. The suggested fix downgrades `envio` to 2.32.12, a breaking change | Accepted: not upgraded; nothing is deployed from this repo |
| L-4 | Informational | Skipped non-ERC-20 logs do not count toward the cap | `fetchTransferHistory` | A contract emitting millions of Transfer-topic logs is paged to the end | Accepted: filtered by address and topic0; the cost is time, not memory |
| L-5 | Informational | Denylist rows are not schema-checked | `src/lib/denylist.ts` | A malformed row throws at load (fails closed) | Accepted: trusted repo content |
| L-6 | Informational | Scripts fall back to the public RPC when `ENVIO_RPC_URL` is unset | `scripts/rpc.ts` | Rate limits only; the scripts are developer-run | Accepted |

## Reporting

Report issues through a GitHub security advisory on this repository.
