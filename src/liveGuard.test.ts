import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

// `npm run test:live` must fail fast with one clear message when it's
// missing what it needs, instead of failing confusingly deep inside a real
// chain read. Each check spawns a real `node` process (via tsx/esm) with
// ENVIO_LIVE_TEST=1 and one required value broken: the guard throws at
// module load, before src/live.test.ts ever reaches a network call, so this
// never touches HyperSync or the RPC.
const GUARD_MESSAGE = "test:live needs ENVIO_API_TOKEN and ENVIO_RPC_URL in .env and a numeric ENVIO_TEST_SWAP_BLOCK";

function liveTestEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ENVIO_LIVE_TEST: "1",
    ENVIO_API_TOKEN: "dummy-token",
    ENVIO_RPC_URL: "https://example.com/rpc",
    ENVIO_TEST_SWAP_BLOCK: "123",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function importLiveTest(env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", "await import('./src/live.test.ts')"],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 15_000 },
  );
}

describe("live.test.ts module-load guard", () => {
  it("throws when ENVIO_API_TOKEN is empty", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_API_TOKEN: "" }));
    expect(result.error).toBeUndefined(); // not killed by the spawnSync timeout
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("throws when ENVIO_RPC_URL is empty", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_RPC_URL: "" }));
    expect(result.error).toBeUndefined(); // not killed by the spawnSync timeout
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("throws when ENVIO_TEST_SWAP_BLOCK is missing", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_TEST_SWAP_BLOCK: "" }));
    expect(result.error).toBeUndefined(); // not killed by the spawnSync timeout
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("throws when ENVIO_TEST_SWAP_BLOCK is not a positive integer", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_TEST_SWAP_BLOCK: "-5" }));
    expect(result.error).toBeUndefined(); // not killed by the spawnSync timeout
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("does not fire when ENVIO_LIVE_TEST is unset, even with the same values missing", () => {
    // Outside vitest's own runner, describe() itself throws once past the
    // guard (no active suite to register into) — so this can only prove our
    // guard did not fire, not that the file "loads fine" under vitest.
    const result = importLiveTest(liveTestEnv({ ENVIO_LIVE_TEST: "", ENVIO_API_TOKEN: "" }));
    expect(result.error).toBeUndefined(); // not killed by the spawnSync timeout
    expect(result.stderr).not.toContain(GUARD_MESSAGE);
  });
});
