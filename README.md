# suitventures-markets-indexer

Envio HyperIndex indexer for SuitVentures Markets on Robinhood Chain (4663).
Spec: `docs/superpowers/specs/2026-09-12-m1-live-data-design.md` in the frontend repo.

## Run

    cp .env.example .env   # add ENVIO_API_TOKEN; keep the public RPC or use Alchemy
    npm install
    npm run codegen
    npm test
    npm run dev            # local Postgres + Hasura via Docker, GraphQL at http://localhost:8080

## Configure

- `config/quotes.json`: the quote allowlist (stock tokens + USDG). `npm run build-quotes` regenerates it from the Pons pool snapshot; `npm run resolve-feeds` fills the Chainlink aggregator per proxy.
- `config/curated-pools.json`: poolId to origin overrides (SUIT).
- `ENVIO_CANDLES_1M_START_BLOCK` / `ENVIO_CANDLES_5M_START_BLOCK`: candle creation windows; `npm run block-at -- <unix seconds>` finds a block.

## Validate against a real pool

    ENVIO_TEST_SWAP_BLOCK=61927786 npm run test:live

Checks the indexed AI/NVDA pool (origin LONG, token AI) and a real swap's price against a wide sanity band around the recent DexScreener price.

## Deploy

Envio Cloud, from the GitHub repo. Set `ENVIO_RPC_URL`, `ENVIO_API_TOKEN`, `ENVIO_CANDLES_1M_START_BLOCK` and `ENVIO_CANDLES_5M_START_BLOCK` as environment variables on the deployment.

`ENVIO_API_TOKEN` is required: the transfer-history replay calls HyperSync directly, and without it each token skips its pre-registration transfers, so holder counts and supply come out wrong.

The Development plan is the M1 demo environment: it deletes a deployment about 10 days after its first sync passes the 100k-event soft limit (7-day grace, then 3 days read-only), and this indexer passes that limit during its first sync. Move to Production Small from the M2 demo onward.

Use start blocks `55799704` (1m) and `36074200` (5m) for the first deployment. If the deploy date moves, recompute both with `npm run block-at`, and set `config.yaml`'s ChainlinkAggregator `start_block` (currently `55799704`) to the new 7-day block too.
