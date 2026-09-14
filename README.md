# suitventures-markets-indexer

Envio HyperIndex indexer for SuitVentures Markets on Robinhood Chain (4663).
Spec: `docs/superpowers/specs/2026-09-12-m1-live-data-design.md` in the frontend repo.

## Run

    cp .env.example .env   # add ENVIO_API_TOKEN and a keyed ENVIO_RPC_URL (Alchemy or similar)
    npm install
    npm run codegen
    npm test
    npm run dev            # local Postgres + Hasura via Docker, GraphQL at http://localhost:8080

## Configure

- `config/quotes.json`: the quote allowlist (stock tokens + USDG). `npm run build-quotes` regenerates it from the Pons pool snapshot; `npm run resolve-feeds` fills the Chainlink aggregator per proxy.
- `config/curated-pools.json`: poolId to origin overrides (SUIT).
- `config/token-denylist.json`: non-stock pairing assets (a wrapped BTC such as cbBTC, and TAO) that must never be tracked as a memestock, however they're paired. `npm run build-quotes` regenerates it alongside `config/quotes.json`.
- `ENVIO_CANDLES_1M_START_BLOCK` / `ENVIO_CANDLES_5M_START_BLOCK`: candle creation windows; `npm run block-at -- <unix seconds>` finds a block.

## Validate against a real pool

    ENVIO_TEST_SWAP_BLOCK=61927786 npm run test:live

Checks the indexed AI/NVDA pool (origin LONG, token AI) and a real swap's price against a wide sanity band around the recent DexScreener price.

## Deploy

Envio Cloud, from the GitHub repo. Set `ENVIO_RPC_URL`, `ENVIO_API_TOKEN`, `ENVIO_CANDLES_1M_START_BLOCK` and `ENVIO_CANDLES_5M_START_BLOCK` as environment variables on the deployment.

`ENVIO_API_TOKEN` and `ENVIO_RPC_URL` must both be set before the first sync: the transfer-history replay calls HyperSync directly, and token metadata is read over RPC. The indexer now refuses to start at all without them, rather than silently skipping pre-registration transfers or falling back to placeholder metadata. A sync that already ran without `ENVIO_API_TOKEN` needs a full resync once it's set — a token discovered before that point never gets its pre-registration history, even after the token is added later.

The Development plan is the M1 demo environment: it deletes a deployment about 10 days after its first sync passes the 100k-event soft limit (7-day grace, then 3 days read-only), and this indexer passes that limit during its first sync. Move to Production Small from the M2 demo onward.

Use start blocks `55799704` (1m) and `36074200` (5m) for the first deployment. If the deploy date moves, recompute both with `npm run block-at` for 7 and 30 days before the deploy, and set `config.yaml`'s ChainlinkAggregator `start_block` (currently `55799704`) to the new 7-day block too.
