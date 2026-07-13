// @fractalboxdev/flare-dispatch-core — the `cloudflare` capability (read-only Cloudflare API).
//
// The Cloudflare-side twin of the `github` read surface: a narrow, read-only
// window into a Cloudflare account so a Schedule-mode run can *discover what to
// act on*. Today it surfaces **Pages deployments** — the signal `ci-triage`
// scans for failed deploys alongside failed GitHub Actions runs.
//
// Backed by the Cloudflare REST API with a scoped `CLOUDFLARE_API_TOKEN`
// (Worker secret) + `CLOUDFLARE_ACCOUNT_ID`; runs never see the token — the live
// Layer holds it. Absent on a deploy, the capability degrades to empty rather
// than failing a run (a triage sweep simply finds nothing CF-side).
//
// Deliberately read-only: a run produces findings / opens a draft PR via the
// `github` capability — it does not mutate Cloudflare state. Mutating CF state
// stays a `wrangler`/CI concern (see the repo's CLAUDE.md).
//
// Spec: specs/03-dsl.md § Capabilities.

import { Context, Effect } from "effect";
import type { CloudflareApiError } from "../errors";

/** A Cloudflare Pages deployment — the unit `ci-triage` inspects. */
export type DeploymentRef = {
  /** The Pages project name. */
  readonly project: string;
  /** The deployment id. */
  readonly id: string;
  /** `production` | `preview`. */
  readonly environment: string;
  /** Latest-stage status — `success` | `failure` | `canceled` | … */
  readonly status: string;
  /** The deployment's URL. */
  readonly url: string;
  /** The source branch that triggered the deployment (when known). */
  readonly branch: string;
  /** epoch ms — when the deployment was created. */
  readonly createdAt: number;
};

/** Per-Worker-script invocation usage over a window — a cost driver. */
export type WorkerUsage = {
  /** The Worker script name (e.g. `flare-dispatch-v0`). */
  readonly script: string;
  /** Total invocations in the window. */
  readonly requests: number;
  /** Invocations that errored (uncaught exception / 5xx) — retry/waste signal. */
  readonly errors: number;
};

/** Per-model AI-inference usage over a window (Workers AI or AI Gateway). */
export type AiModelUsage = {
  /** The model id (e.g. `@cf/meta/llama-3.1-8b` or `glm-4.7-flash`). */
  readonly model: string;
  /** The provider (`workers-ai`, `anthropic`, `deepseek`, …). `workers-ai`
   * spend is billed in Neurons; others bill their own tokens. */
  readonly provider: string;
  /** Total inference requests in the window. */
  readonly requests: number;
  /** Requests served from the AI Gateway cache (free — a savings lever: low
   * `cached/requests` on a hot model means caching is leaving money on the
   * table). */
  readonly cached: number;
};

/** A read-only usage snapshot for FinOps analysis — the cost picture of the
 * account's Workers + AI inference over `windowHours`. */
export type CloudflareUsage = {
  readonly windowHours: number;
  /** Worker invocations by script, descending by requests. */
  readonly workers: readonly WorkerUsage[];
  /** AI inference by model, descending by requests. */
  readonly ai: readonly AiModelUsage[];
};

/** The service contract a runtime Layer implements. */
export interface CloudflareService {
  /**
   * Pages deployments across the account. `projects` narrows to a set of Pages
   * projects (else every project on the account); `status` / `environment` /
   * `createdWithinHours` narrow the rows. Paginates internally and backs off on
   * rate limits.
   */
  readonly deployments: (opts?: {
    projects?: readonly string[];
    environment?: string;
    status?: string;
    createdWithinHours?: number;
  }) => Effect.Effect<readonly DeploymentRef[], CloudflareApiError>;

  /**
   * Account usage over the trailing `windowHours` (default 168 = 7 days) — the
   * cost picture a FinOps run analyses: Worker invocations + errors by script,
   * and AI inference requests + cache hits by model. Read via the GraphQL
   * Analytics API. Absent creds → the deferred Layer returns an empty snapshot.
   */
  readonly usage: (opts?: {
    windowHours?: number;
  }) => Effect.Effect<CloudflareUsage, CloudflareApiError>;
}

/** Context.Tag — the dependency a run carries until a Layer provides it. */
export class Cloudflare extends Context.Tag("@fractalboxdev/flare-dispatch-core/Cloudflare")<
  Cloudflare,
  CloudflareService
>() {}

/**
 * The `cloudflare` accessor namespace — reads the service from context and
 * delegates, so a run writes `cloudflare.deployments(...)` rather than the
 * explicit `Effect.flatMap(Cloudflare, ...)`.
 */
export const cloudflare = {
  deployments: (
    opts: {
      projects?: readonly string[];
      environment?: string;
      status?: string;
      createdWithinHours?: number;
    } = {},
  ) => Effect.flatMap(Cloudflare, (c) => c.deployments(opts)),
  usage: (opts: { windowHours?: number } = {}) =>
    Effect.flatMap(Cloudflare, (c) => c.usage(opts)),
} as const;
