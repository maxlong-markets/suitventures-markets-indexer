import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

// Without ENVIO_API_TOKEN, the transfer-history replay silently returns
// nothing while historyLoaded still gets set true, so supply and holders come
// out wrong for every token; without ENVIO_RPC_URL, every token gets fallback
// metadata with no warning at all. Both effect modules must throw at module
// load instead, but only for a real (non-test) run: vitest blanks both
// variables on purpose (see vitest.config.ts), so the guard must not fire
// under VITEST.
//
// Each check spawns a real, separate `node` process — importing the module
// in-process wouldn't exercise "module load in an environment where VITEST
// isn't set" at all, since this test file itself always runs under vitest.

// Builds the child's env from this process's own env, then strips every
// VITEST* key so the guard sees a "real" run, and sets the one variable
// under test. Never logs process.env itself, only the specific keys touched.
function realRunEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) delete env[key];
  }
  return { ...env, ...overrides };
}

function importModule(relativePath: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", `await import('${relativePath}')`],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
}

describe("effect module-load env guards", () => {
  it("transferHistory.ts throws when ENVIO_API_TOKEN is empty outside of VITEST", () => {
    const result = importModule("./src/effects/transferHistory.ts", realRunEnv({ ENVIO_API_TOKEN: "" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENVIO_API_TOKEN is required");
  });

  it("transferHistory.ts loads fine with a configured token outside of VITEST", () => {
    const result = importModule("./src/effects/transferHistory.ts", realRunEnv({ ENVIO_API_TOKEN: "dummy-token" }));
    expect(result.status).toBe(0);
  });

  it("tokenMetadata.ts throws when ENVIO_RPC_URL is empty outside of VITEST", () => {
    const result = importModule("./src/effects/tokenMetadata.ts", realRunEnv({ ENVIO_RPC_URL: "" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENVIO_RPC_URL is required");
  });

  it("tokenMetadata.ts loads fine with a configured RPC URL outside of VITEST", () => {
    const result = importModule("./src/effects/tokenMetadata.ts", realRunEnv({ ENVIO_RPC_URL: "https://example.com/rpc" }));
    expect(result.status).toBe(0);
  });
});
