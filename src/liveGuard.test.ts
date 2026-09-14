import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

// `npm run test:live` must fail fast with one clear message when it's
// missing what it needs, instead of failing confusingly deep inside a real
// chain read. Each check spawns a real `node` process (via tsx/esm) with
// ENVIO_LIVE_TEST=1 and one required value broken: the guard throws at
// module load, before src/live.test.ts ever reaches a network call, so this
// never touches HyperSync or the RPC.
const GUARD_MESSAGE = "test:live needs ENVIO_API_TOKEN and ENVIO_RPC_URL in .env and a numeric ENVIO_TEST_SWAP_BLOCK";

function liveTestEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ENVIO_LIVE_TEST: "1",
    ENVIO_API_TOKEN: "dummy-token",
    ENVIO_RPC_URL: "https://example.com/rpc",
    ENVIO_TEST_SWAP_BLOCK: "123",
    ...overrides,
  };
}

// Throws result.error itself (rather than leaving each call site to assert
// it's undefined) so a spawn failure -- e.g. killed by the timeout -- fails
// loudly with its own message/stack, instead of silently looking like a
// child that exited with the "wrong" status or stderr.
function importLiveTest(env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", "await import('./src/live.test.ts')"],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 15_000 },
  );
  if (result.error) throw result.error;
  return result;
}

describe("live.test.ts module-load guard", () => {
  it("throws when ENVIO_API_TOKEN is empty", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_API_TOKEN: "" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("throws when ENVIO_RPC_URL is empty", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_RPC_URL: "" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("throws when ENVIO_TEST_SWAP_BLOCK is missing or empty", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_TEST_SWAP_BLOCK: "" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("throws when ENVIO_TEST_SWAP_BLOCK is not a positive integer", () => {
    const result = importLiveTest(liveTestEnv({ ENVIO_TEST_SWAP_BLOCK: "-5" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MESSAGE);
  });

  it("does not fire when ENVIO_LIVE_TEST is unset, even with the same values missing", () => {
    // Outside vitest's own runner, describe() itself throws once past the
    // guard (no active suite to register into) — so this can only prove our
    // guard did not fire, not that the file "loads fine" under vitest.
    // Asserting on that failure below proves the child actually reached and
    // passed the guard, rather than merely crashing before it for some
    // unrelated reason (which would just as easily leave GUARD_MESSAGE
    // absent). The failure is a TypeError thrown from inside @vitest/runner
    // 4.1.0 (vitest is pinned exactly in package.json) rather than our own
    // code; confirmed by running the child once. Its exact wording is an
    // internal detail of that package version (which of its unguarded
    // `runner.config` reads happens to run first) and not asserted on here,
    // so this doesn't need re-capturing for a patch release, but the
    // TypeError/@vitest/runner shape itself should be re-confirmed the same
    // way on a vitest upgrade.
    const result = importLiveTest(liveTestEnv({ ENVIO_LIVE_TEST: "", ENVIO_API_TOKEN: "" }));
    expect(result.stderr).not.toContain(GUARD_MESSAGE);
    expect(result.stderr).toMatch(/TypeError/);
    expect(result.stderr).toContain("@vitest/runner");
  });
});
