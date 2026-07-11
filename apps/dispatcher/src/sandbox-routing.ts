// FlareDispatch Dispatcher — sandbox image routing.
//
// A run declares which baked container image it needs via `sandboxImage`
// (define-run.ts § SandboxImage); the dispatcher maps that to one of the
// deployed Container bindings. This module holds ONLY the pure selection logic
// (no `@cloudflare/sandbox` / `cloudflare:workers` imports) so it stays testable
// under plain Node + Vitest 2, matching the rest of the dispatcher's route code.
//
// The routing axis is DISTINCT from `limits.requiresBrowser`: that reserves a CF
// Browser Rendering CDP slot (the run connects *out* to a CF-managed browser and
// stays on the lean image); `sandboxImage` picks the image the container boots.

import type { SandboxImage } from "@fractalbox/flare-dispatch-core";

/**
 * Pick the Container binding for a run's declared `sandboxImage`. Generic over
 * the binding type so it's unit-testable with sentinels (the real call passes
 * `DurableObjectNamespace<Sandbox>` values).
 *
 * Rules:
 *   - `"browser"` + a bound browser image → the browser binding.
 *   - `"browser"` + NO browser binding → the lean binding (soft degrade against
 *     a missing binding: routes somewhere valid instead of crashing on an
 *     unbound namespace. The browser run only actually SUCCEEDS on lean if its
 *     command still installs a browser itself — one relying on the baked image
 *     finds no chromium and fails. Not a guarantee, just a non-crash).
 *   - `"lean"` / `undefined` (the default) → the lean binding.
 */
export const selectSandboxNs = <T>(
  sandboxImage: SandboxImage | undefined,
  bindings: {
    readonly lean: T;
    readonly browser: T | undefined;
    readonly agent?: T | undefined;
  },
): T => {
  if (sandboxImage === "browser" && bindings.browser !== undefined) {
    return bindings.browser;
  }
  // `"agent"` → the agent-tier image (flare-agent + toolchain baked in, mandatory
  // egress allowlist). Soft-degrade to lean against a missing binding (non-crash);
  // a self-heal run on lean finds no `flare-agent` and fails — same posture as the
  // browser tier. specs/08-self-healing.md § 6.2.
  if (sandboxImage === "agent" && bindings.agent !== undefined) {
    return bindings.agent;
  }
  return bindings.lean;
};
