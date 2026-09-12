import { indexer } from "envio";

indexer.onEvent(
  { contract: "PoolManager", event: "Initialize", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    context.Pool.set({
      id: event.params.id.toLowerCase(),
      hooks: event.params.hooks.toLowerCase(),
      createdAt: event.block.timestamp,
    });
  },
);
