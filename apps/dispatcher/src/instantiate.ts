// FlareDispatch Dispatcher — the shared RunWorkflow instantiation path.
//
// Extracted from `routes/dispatch.ts` so EVERY trigger surface that ends in a
// `RUNS_WORKFLOW.create` — Action mode (`routes/dispatch.ts`), Schedule mode
// (`routes/scheduled.ts`), and signal ingress (`routes/signals-webhook.ts`) —
// drives the exact same execution path:
//
//   1. receiver-level dedup short-circuit on `IDEMPOTENCY_KV` (when bound),
//      written BEFORE the create to close the TOCTOU window;
//   2. `RUNS_WORKFLOW.create({ id, params })`, with the platform's duplicate-id
//      raise (`instance.already_exists`) swallowed — that raise IS the
//      Workflow-level dedup the spec relies on (specs/04-gha § Receiver dedup);
//   3. the dashboard deep-link computed once, returned to the caller.
//
// The `params` shape is exactly the `DispatchPayload` `RunWorkflow.run` decodes
// (apps/dispatcher/src/workflow.ts) — the callers assemble the `github` block
// and validated `inputs`; this module owns only the dedup + create mechanics.

import { workflowDashboardUrl } from "./dashboard-url";
import type { Env } from "./env";

/** TTL on receiver-dedup KV entries — spec 04-gha § Receiver dedup (24h). */
const IDEMPOTENCY_TTL_SEC = 86_400;

/** The `github` context block the `executions` D1 row + check-run callback use. */
interface GithubBlock {
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly installation_id?: number;
  readonly pr_number?: number;
}

/** Everything an instantiation needs that the caller already validated. */
export interface InstantiateArgs {
  /** Doubles as the Workflow instance id AND the returned `executionId`. */
  readonly executionId: string;
  readonly run: string;
  readonly github: GithubBlock;
  /** The run-specific, already-Schema-decoded inputs. */
  readonly inputs: unknown;
  /** Optional completion-notify recipients (empty list dropped by the caller). */
  readonly notify?: { readonly emails: readonly string[] };
  /** Absolute origin so the run's artifact URLs come back absolute. */
  readonly origin: string;
}

/** The outcome of an instantiation — the bits the 202 response carries. */
export interface InstantiateResult {
  readonly executionId: string;
  /** Cloudflare dashboard deep-link, or `undefined` when account id unset. */
  readonly detailsUrl: string | undefined;
}

/**
 * Run the shared dedup → create → dashboard-link path. Idempotent: a second
 * call on the same `executionId` short-circuits on the KV entry (when bound)
 * or is swallowed at the platform's duplicate-create raise.
 *
 * Never throws on a duplicate id; any OTHER `create` failure propagates so the
 * caller surfaces it (callers wrap the whole handler so it cannot escape as an
 * uncaught throw).
 */
export const instantiateRun = async (
  env: Env,
  args: InstantiateArgs,
): Promise<InstantiateResult> => {
  const { executionId } = args;
  const detailsUrl = workflowDashboardUrl(env.CLOUDFLARE_ACCOUNT_ID, executionId);

  // Receiver-level dedup: write the KV entry FIRST (before touching Workflows)
  // so a concurrent duplicate request sees the key and short-circuits. `put`
  // with `expirationTtl` is idempotent. Without IDEMPOTENCY_KV, dedup falls
  // back to CF Workflows' platform-level `create({id})` raise below.
  if (env.IDEMPOTENCY_KV !== undefined) {
    const existing = await env.IDEMPOTENCY_KV.get(executionId);
    if (existing !== null) {
      return { executionId, detailsUrl };
    }
    await env.IDEMPOTENCY_KV.put(executionId, executionId, {
      expirationTtl: IDEMPOTENCY_TTL_SEC,
    });
  }

  const params = {
    executionId,
    run: args.run,
    github: {
      repo: args.github.repo,
      ref: args.github.ref,
      sha: args.github.sha,
      ...(args.github.installation_id !== undefined
        ? { installation_id: args.github.installation_id }
        : {}),
      ...(args.github.pr_number !== undefined
        ? { pr_number: args.github.pr_number }
        : {}),
    },
    inputs: args.inputs,
    ...(args.notify !== undefined && args.notify.emails.length > 0
      ? { notify: { emails: args.notify.emails } }
      : {}),
    origin: args.origin,
  };

  // CF Workflows rejects a `create({id})` whose id was seen before with
  // `instance.already_exists` — including ids whose instances have since been
  // terminated. The idempotency contract is "same id → same execution", so a
  // duplicate create on a known id is the intended end-state and we swallow it.
  // Any other failure must propagate.
  try {
    await env.RUNS_WORKFLOW.create({ id: executionId, params });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (!/already.?exists|duplicate/i.test(msg)) throw cause;
  }

  return { executionId, detailsUrl };
};
