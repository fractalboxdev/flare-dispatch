// @fractalbox/flare-dispatch-core — defineRun.
//
// `defineRun` is a passive constructor: it validates the spec at module load
// and registers the run for discovery. It binds to no runtime — the same Run
// value executes against CFRuntimeLive, Dev, or Test (specs/03-dsl.md § Layers).
//
// Spec: specs/03-dsl.md § defineRun.

import type { Effect, Schema } from "effect";
import type { RunContext } from "./context";
import type { RunError } from "./errors";
import type { WritebackSpec } from "./writeback";

export type RunLimits = {
  readonly maxDurationSec: number;
  readonly maxConcurrency?: number;
  readonly requiresBrowser?: boolean;
};

/**
 * A dispatch-rate cap: at most one execution per `seconds` within a `scope`.
 *
 * `scope` derives the rate-limit bucket from the run's (validated) inputs —
 * e.g. `pr-review` scopes per pull request (`pr-<number>`), so a rapid push
 * sequence on one PR collapses to one review per window while other PRs are
 * unaffected. The full cooldown key is `{run}:{repo}:{scope}`, so scopes never
 * collide across repos or runs.
 *
 * Enforced at BOTH dispatch entry points (Action-mode `/v1/dispatch` and the
 * webhook receiver) using `IDEMPOTENCY_KV`; without that binding the cooldown
 * is not enforced (best-effort, like receiver-level dedup). A dispatch landing
 * inside the window is acknowledged (202) with the prior execution's id and
 * `skipped: "cooldown"` — never an error, so a gating CI step stays green.
 */
export type CooldownSpec<I> = {
  /** Window length in seconds. Effective floor is 60 (KV's minimum TTL). */
  readonly seconds: number;
  /** Rate-limit bucket within `{run}:{repo}` — e.g. ``pr-${input.pr}``. */
  readonly scope: (input: I) => string;
};

/** The raw GitHub webhook delivery; a run narrows it per-event itself. */
export type WebhookPayload = Record<string, any>;

/** A single Webhook-mode trigger binding — see specs/04-gha-integration.md. */
export type TriggerSpec<I> = {
  readonly event: string;
  readonly actions?: readonly string[];
  readonly idempotencyKey: (ctx: { payload: WebhookPayload }) => string;
  readonly gate?: (ctx: { payload: WebhookPayload }) => boolean;
  readonly inputs: (ctx: { payload: WebhookPayload }) => I;
};

/**
 * The context a cron tick provides — there is no GitHub payload.
 * See specs/03-dsl.md § `ScheduleContext`.
 */
export type ScheduleContext = {
  readonly cron: string;
  readonly firedAt: number;
};

/**
 * A single Schedule-mode trigger binding — see specs/04-gha-integration.md
 * § Schedule mode. Mirrors `TriggerSpec` but the callbacks receive a
 * `ScheduleContext` (no webhook payload). `inputs` produces a *scope*, not a
 * concrete target — for single-target runs (e.g. nightly-e2e against a fixed
 * env), the input is the full body; for sweeps, it's coarse and the run
 * enumerates targets in its first step.
 */
export type ScheduleSpec<I> = {
  /** CF cron expression; MUST also be in wrangler `triggers.crons`. */
  readonly cron: string;
  readonly idempotencyKey: (ctx: ScheduleContext) => string;
  readonly gate?: (ctx: ScheduleContext) => boolean;
  readonly inputs: (ctx: ScheduleContext) => I;
};

/**
 * Which baked sandbox image a run executes in. The dispatcher maps this to a
 * deployed Container binding (`RUNS_SANDBOX` vs `RUNS_SANDBOX_BROWSER`) — see
 * apps/dispatcher/src/workflow.ts.
 *
 *   - `"lean"` (default) — the base sandbox image. Correct for the majority of
 *     runs AND for every `limits.requiresBrowser: true` run: those dial CF
 *     Browser Rendering over CDP (they connect *out* to a CF-managed browser),
 *     so they need NO chromium baked in the image.
 *   - `"browser"` — the image with `chromium-headless-shell` baked in. For a run
 *     that launches Playwright's OWN chromium *inside* the sandbox AND drops the
 *     `playwright install` step from its command to rely on the baked browser.
 *     No run currently does: `playwright-demo` runs chromium in-sandbox but its
 *     caller installs it, so it stays `"lean"` (depending on a separately-built
 *     image a `versions upload` can leave unprovisioned regressed it). This
 *     value is wired and available, just unused until such a run exists.
 *
 * NOTE this axis is deliberately distinct from `limits.requiresBrowser`. They
 * answer different questions: `requiresBrowser` = "reserve a CF Browser
 * Rendering slot"; `sandboxImage` = "which container image to boot". A run can
 * be `requiresBrowser: true, sandboxImage: "lean"` (CDP, no in-image browser)
 * or `requiresBrowser: false, sandboxImage: "browser"` (in-sandbox Playwright).
 */
export type SandboxImage = "lean" | "browser" | "agent";

export type RunSpec<I, O, IEnc, OEnc> = {
  readonly name: string;
  readonly version: string;
  /**
   * A fully-qualified container image URI override (e.g.
   * `registry.cloudflare.com/<acct>/<repo>:<tag>`) declaring the image this run
   * is BUILT to run in. Documentary today — several runs set it (`pr-review`,
   * `playwright-e2e`, `release-notes`) but the CF runtime does not yet pull a
   * per-run registry image; Container images are bound to DO classes at deploy.
   *
   * Do NOT confuse with `sandboxImage` below: `image` names a *specific
   * registry artifact* (a future per-run image-pull knob); `sandboxImage`
   * selects which of the deploy's ALREADY-BOUND images (`"lean" | "browser"`)
   * the dispatcher routes to — and is the field that actually drives routing.
   */
  readonly image?: string;
  /** Which baked, deploy-bound sandbox image to route this run to. Default
   * `"lean"`. Drives the dispatcher's Container-binding selection — see
   * `SandboxImage` above. */
  readonly sandboxImage?: SandboxImage;
  readonly inputs: Schema.Schema<I, IEnc>;
  readonly outputs: Schema.Schema<O, OEnc>;
  readonly limits: RunLimits;
  readonly triggers?: readonly TriggerSpec<I>[];
  readonly schedules?: readonly ScheduleSpec<I>[];
  /**
   * Declares that this run can "propose a diff as a PR". When set, the run's
   * container writes a changed-files manifest + blobs to a conventional
   * artifact location; after a SUCCESSFUL run the Dispatcher Worker — never the
   * container — validates the manifest against this spec and commits it via the
   * GitHub App's Git Data API, then opens/updates a PR. The capability is
   * declared HERE (trusted, Worker-side); the container only fills in the file
   * contents within the envelope this spec allows. See `./writeback`.
   */
  readonly writeback?: WritebackSpec;
  /**
   * Optional dispatch-rate cap — at most one execution per window per scope.
   * See `CooldownSpec`. Applies to Action-mode AND webhook-mode dispatches;
   * Schedule mode is exempt (crons self-pace).
   */
  readonly cooldown?: CooldownSpec<I>;
  readonly run: (input: I) => Effect.Effect<O, RunError, RunContext>;
};

/** A defined run — a portable value, not bound to any runtime. */
export type Run<I, O> = RunSpec<I, O, unknown, unknown> & {
  readonly _tag: "Run";
};

/** kebab-case: lowercase alphanumerics, single hyphens, no leading/trailing. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A pragmatic semver match — `major.minor.patch` with optional pre-release. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

export const defineRun = <I, O, IEnc, OEnc>(
  spec: RunSpec<I, O, IEnc, OEnc>,
): Run<I, O> => {
  // Load-time validation: a malformed run spec is a build-time bug, not a
  // dispatch-time surprise — fail fast at module load. (specs/03-dsl.md
  // § defineRun: "validates the spec at module load".)
  if (!KEBAB_CASE.test(spec.name)) {
    throw new Error(
      `defineRun: \`name\` must be kebab-case, got ${JSON.stringify(spec.name)}`,
    );
  }
  if (!SEMVER.test(spec.version)) {
    throw new Error(
      `defineRun: \`version\` must be semver (major.minor.patch), got ${JSON.stringify(
        spec.version,
      )} for run "${spec.name}"`,
    );
  }
  if (
    !Number.isFinite(spec.limits.maxDurationSec) ||
    spec.limits.maxDurationSec <= 0
  ) {
    throw new Error(
      `defineRun: \`limits.maxDurationSec\` must be a positive number, got ${spec.limits.maxDurationSec} for run "${spec.name}"`,
    );
  }
  if (
    spec.cooldown !== undefined &&
    (!Number.isFinite(spec.cooldown.seconds) || spec.cooldown.seconds <= 0)
  ) {
    throw new Error(
      `defineRun: \`cooldown.seconds\` must be a positive number, got ${spec.cooldown.seconds} for run "${spec.name}"`,
    );
  }
  if (spec.writeback !== undefined) {
    const wb = spec.writeback;
    const branchName =
      typeof wb.branch === "string" ? wb.branch : wb.branch.prefix;
    if (branchName.trim().length === 0) {
      throw new Error(
        `defineRun: \`writeback.branch\` must be a non-empty branch name (or { prefix }) for run "${spec.name}"`,
      );
    }
    if (wb.commitMessage.trim().length === 0) {
      throw new Error(
        `defineRun: \`writeback.commitMessage\` must be non-empty for run "${spec.name}"`,
      );
    }
    if (wb.maxBytes !== undefined && wb.maxBytes <= 0) {
      throw new Error(
        `defineRun: \`writeback.maxBytes\` must be positive, got ${wb.maxBytes} for run "${spec.name}"`,
      );
    }
    if (wb.maxFiles !== undefined && wb.maxFiles <= 0) {
      throw new Error(
        `defineRun: \`writeback.maxFiles\` must be positive, got ${wb.maxFiles} for run "${spec.name}"`,
      );
    }
  }
  return { ...spec, _tag: "Run" } as Run<I, O>;
};
