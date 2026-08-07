// The prefix rule, pinned where CI can see it.
//
// This suite exists because of where the bug landed rather than what it was.
// `mountArtifacts` mounted `/artifacts` on a RELATIVE prefix, the SDK's
// `validatePrefix` rejects those, and the resulting throw was swallowed — so
// every command in every container exited 1 having run nothing, and the deploy
// canary read that as `inconclusive` and gated seven consecutive deploys.
//
// The natural home for a regression guard is `sandbox-do.workers.test.ts`,
// next to the code. That file is invisible to CI: `pnpm test` resolves the
// root `vitest.workspace.ts`, which lists `apps/substrate` (this Node project)
// but deliberately omits `apps/substrate/vitest.workers.config.ts`. So the
// rule is asserted here, against a module that imports nothing from the
// Cloudflare runtime.
import { describe, expect, it } from "vitest";
import { ARTIFACTS_DIR, artifactsPrefix } from "./artifacts";

describe("the artifacts mount prefix", () => {
  it("is absolute, which is the rule validatePrefix enforces", () => {
    // The SDK check, restated: `if (!prefix.startsWith("/")) throw
    // InvalidMountConfigError`. Identical in 0.10.1 and 0.12.4. The workers
    // suite drives the real SDK call; this is the half CI can run.
    expect(artifactsPrefix("abc123").startsWith("/")).toBe(true);
  });

  it("scopes to the container id, so two executions cannot read each other", () => {
    expect(artifactsPrefix("abc123")).toBe("/artifacts/abc123/");
    expect(artifactsPrefix("def456")).not.toBe(artifactsPrefix("abc123"));
  });

  it("ends in a slash, so keys land under the prefix and not beside it", () => {
    expect(artifactsPrefix("abc123").endsWith("/")).toBe(true);
  });

  it("agrees with the mount path, which is what the redirect target is built from", () => {
    // `run` redirects into `${ARTIFACTS_DIR}/…`. If these two drift, the
    // redirect writes outside the mount and the log silently goes nowhere.
    expect(artifactsPrefix("abc123").startsWith(`${ARTIFACTS_DIR}/`)).toBe(true);
  });
});
