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

Envio Cloud, from the GitHub repo. The deployment needs `ENVIO_RPC_URL`, `ENVIO_CANDLES_1M_START_BLOCK` and `ENVIO_CANDLES_5M_START_BLOCK` as environment variables; `ENVIO_API_TOKEN` is provided by Envio Cloud itself. The Development plan is the M1 demo environment (30-day life, 100k-event soft limit); move to Production Small from the M2 demo onward. The first deployment used start blocks `55799704` (1m) and `36074200` (5m).
