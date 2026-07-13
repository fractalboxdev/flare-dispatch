// FlareDispatch Dispatcher — `POST /v1/dispatch/:run`.
//
// The dispatch path: a GHA Action (or any HMAC-signing caller) POSTs a dispatch
// body; the Dispatcher verifies it, validates it, and instantiates a
// `RunWorkflow` execution. Per specs/04-gha-integration.md § Failure handling
// the contract is:
//
//   401  HMAC missing/mismatch          — config bug, NO retry
//   404  unknown run name               — run not on this deploy
//   400  body / inputs fail Schema      — Schema parse error inlined in body
//   202  accepted                       — `{ "executionId": "<ulid>" }`
//
// --- Read order: verify, THEN parse ------------------------------------------
//
// The body is read ONCE as raw bytes (`request.arrayBuffer()`), HMAC-verified
// against those exact bytes (see hmac.ts — raw-bytes canonicalization is locked
// per plan § 6), and only then JSON-parsed. Verifying the raw bytes before any
// parse is what makes the raw-bytes contract hold: a parse-then-reserialize
// would change the octets and break the MAC.
//
// Spec: specs/04-gha-integration.md § Dispatch body + § Failure handling,
//       specs/05-byoc.md § Security posture, specs/pm/plan.md § PR5.

import { Either, ParseResult, Schema } from "effect";
import type { ParseError } from "effect/ParseResult";
import { checkAndArmCooldown } from "../cooldown";
import { workflowDashboardUrl } from "../dashboard-url";
import type { Env } from "../env";
import { fingerprint, SIGNATURE_HEADER, verify } from "../hmac";
import { toInstanceId } from "../instance-id";
import { buildLogsUrl, resolveLogLinkSecret, signLogToken } from "../log-token";
import { lookupRun } from "../registry";

/** TTL on receiver-dedup KV entries — spec 04-gha § Receiver dedup (24h). */
const IDEMPOTENCY_TTL_SEC = 86_400;

/**
 * Build the semantic Workflow instanceId per spec 04-gha § Receiver dedup:
 * `{run}:{repo}:{sha[:12]}`, with `/` in the repo replaced with `_` so the
 * id is a single path segment. Two dispatches naming the same logical work
 * collapse onto one execution at the CF Workflows layer.
 *
 * SHA is truncated to 12 chars to keep the id well within CF Workflows'
 * 64-char instance-id limit; 12 hex chars is ~4.7e14 — collision space large
 * enough for a single repo's worth of unique commits.
 */
const semanticInstanceId = (run: string, repo: string, sha: string): string =>
  `${run}:${repo.replace(/\//g, "_")}:${sha.slice(0, 12)}`;

/** JSON helper — a `Response` with the right content-type. */
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The `github` context a dispatch carries — specs/04-gha-integration.md
 * § Dispatch body. `installation_id` is the GitHub App installation id PR6's
 * check-run callback needs to mint an installation token; it is **optional**
 * but, when present, MUST be a positive integer.
 *
 * The optionality matches the graceful-degradation contract in
 * `packages/runtime-cf/src/checks-github.ts` (`makeChecksGithubLive(undefined)`
 * returns a no-op `Checks` service): omitting `installation_id` means "do not
 * post a check-run — execute and record D1/R2 only". This is the right shape
 * for local dev, ad-hoc curl dispatches, and CI on repos where the App isn't
 * installed yet.
 *
 * `0` is explicitly rejected (a positive-integer refinement) because the
 * upstream JS Action defaults the `installation-id` input to `"0"` when unset,
 * which used to silently flow through to `getInstallationToken(0)` →
 * `Effect.orDie` (or worse, silently no-op when App secrets were absent),
 * leaving the PR with no `flare-dispatch/*` check-run even though the
 * dispatch step reported green. Rejecting 0 at the gate surfaces the
 * misconfig as a 400 the operator can see in the GHA log on the very first
 * run, instead of as a missing check-run discovered hours later.
 *
 * `pr_number` / `actor` are optional metadata that don't affect execution.
 */
const GithubContext = Schema.Struct({
  repo: Schema.String,
  ref: Schema.optionalWith(Schema.String, {
    default: () => "refs/heads/main",
  }),
  sha: Schema.String,
  pr_number: Schema.optional(Schema.Number),
  actor: Schema.optional(Schema.String),
  installation_id: Schema.optional(
    Schema.Number.pipe(
      Schema.positive({
        message: () =>
          'installation_id must be a positive GitHub App installation id (got 0). Either pass the `installation-id` action input — resolve via `gh api orgs/<org>/installations` — or omit the field entirely to dispatch without posting a check-run.',
      }),
    ),
  ),
});

/**
 * A syntactically-valid email address. A loose single-`@` check — the
 * authoritative gate is Cloudflare's verified-destination-address enforcement
 * at send time; this only rejects obvious garbage (empty, no `@`, whitespace)
 * before it reaches the Workflow payload.
 */
const EmailAddress = Schema.String.pipe(
  Schema.pattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, {
    message: () => "must be a valid email address",
  }),
);

/**
 * Optional completion-notify block — specs/04-gha-integration.md
 * § Notifications. When `emails` is present, the Workflow emails each address
 * the run's verdict + output (artifact / demo / log links) at completion. The
 * recipients must be verified Email Routing destination addresses on the
 * deploy's zone for delivery to succeed.
 */
const NotifySpec = Schema.Struct({
  emails: Schema.Array(EmailAddress),
});

/**
 * The dispatch body — specs/04-gha-integration.md § Dispatch body. `inputs` is
 * left `Unknown` here and validated separately against the *named run's*
 * `inputs` Schema, so the 400 carries the run-specific parse error.
 */
const DispatchBody = Schema.Struct({
  run: Schema.String,
  github: GithubContext,
  inputs: Schema.Unknown,
  trigger: Schema.optional(Schema.Unknown),
  notify: Schema.optional(NotifySpec),
});

/** Render an Effect `ParseError` as the multi-line tree a caller can act on. */
const formatParseError = (error: ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

/**
 * Handle `POST /v1/dispatch/:run`.
 *
 * @param request   the inbound request — body read once as raw bytes.
 * @param env       binding env (`HMAC_SECRET`, `RUNS_WORKFLOW`).
 * @param runName   the `:run` path segment.
 */
export const handleDispatch = async (
  request: Request,
  env: Env,
  runName: string,
): Promise<Response> => {
  // 1. Read the raw body bytes ONCE — this is what the HMAC is computed over.
  const rawBody = await request.arrayBuffer();

  // 2. HMAC-verify the raw bytes. Missing/mismatched → 401, no retry.
  //
  // The 401 body carries `dispatcher_secret_fingerprint` — sha256(HMAC_SECRET)[:8]
  // — so an operator can match it against the caller-side fingerprint printed
  // by the GHA Action and pinpoint which side has the wrong value (issue #24).
  // Non-secret: 32 bits of pre-image after SHA-256 truncation is useless as a
  // credential, same shape as a git short-SHA.
  const signature = request.headers.get(SIGNATURE_HEADER);
  const signatureOk = await verify(env.HMAC_SECRET, signature, rawBody);
  if (!signatureOk) {
    return json(
      {
        error: "unauthorized",
        message: "HMAC signature missing or invalid",
        dispatcher_secret_fingerprint: await fingerprint(env.HMAC_SECRET),
      },
      401,
    );
  }

  // 3. Unknown run name → 404. (Checked after HMAC so an unauthenticated
  //    caller cannot probe which runs exist.)
  const run = lookupRun(runName);
  if (run === undefined) {
    return json(
      {
        error: "run_not_found",
        message: `unknown run "${runName}"`,
        run: runName,
      },
      404,
    );
  }

  // 4. Parse the body as JSON, then Schema-validate the envelope. A parse
  //    failure or an envelope-shape mismatch is a 400 with the error inlined.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (cause) {
    return json(
      {
        error: "invalid_body",
        message: "request body is not valid JSON",
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      400,
    );
  }

  const bodyResult = Schema.decodeUnknownEither(DispatchBody)(parsed);
  const body = Either.getOrUndefined(bodyResult);
  if (body === undefined) {
    return json(
      {
        error: "invalid_body",
        message: "dispatch body failed schema validation",
        detail: Either.match(bodyResult, {
          onLeft: formatParseError,
          onRight: () => "",
        }),
      },
      400,
    );
  }

  // 5. Validate `inputs` against the *named run's* own Schema — the 400 here
  //    carries the run-specific parse error.
  const inputsResult = Schema.decodeUnknownEither(run.inputs)(body.inputs);
  const inputs = Either.getOrUndefined(inputsResult);
  if (inputs === undefined) {
    return json(
      {
        error: "invalid_inputs",
        message: `inputs failed schema validation for run "${runName}"`,
        detail: Either.match(inputsResult, {
          onLeft: formatParseError,
          onRight: () => "",
        }),
      },
      400,
    );
  }

  // 6. Compute the dedup key + Workflow instanceId.
  //    Precedence: explicit `Idempotency-Key` header (direct callers MUST send
  //    one per spec 04-gha) → semantic `{run}:{repo}:{sha}` fallback. Both
  //    serve as BOTH the executionId returned to the caller AND the Workflow
  //    instanceId, so platform-level `create({id})` dedup is automatic.
  //    `toInstanceId` makes the result a valid CF Workflows id (the semantic
  //    fallback and arbitrary caller-supplied header keys can carry `:` / `/`
  //    or overrun 64 chars, which `create({ id })` rejects as `invalid_id`).
  const headerKey = request.headers.get("Idempotency-Key");
  const executionId = toInstanceId(
    headerKey && headerKey.length > 0
      ? headerKey
      : semanticInstanceId(body.run, body.github.repo, body.github.sha),
  );

  // The Cloudflare Workflows instance page for this execution. Returned in the
  // 202 (below) so the caller — the GHA Action — can surface a clickable link
  // immediately, for BOTH success and failure (the check-run + email only carry
  // it once the run finishes, and omit it on a failed run). `undefined` when
  // CLOUDFLARE_ACCOUNT_ID is unset (BYOC default): the field is then omitted
  // and the response is byte-identical to the pre-feature shape.
  const detailsUrl = workflowDashboardUrl(env.CLOUDFLARE_ACCOUNT_ID, executionId);

  // The tokened log-viewer URL — returned in the 202 so the caller (and the
  // await-mode poller, which reads `/v1/executions/:id` with the same token)
  // has a clickable, full-log link the instant the run is accepted. `undefined`
  // only when no log-link key material is configured (neither LOG_LINK_SECRET
  // nor HMAC_SECRET) — but HMAC_SECRET is required to reach this point, so in
  // practice it is always present.
  const logSecret = resolveLogLinkSecret(env);
  const origin = env.PUBLIC_ORIGIN ?? new URL(request.url).origin;
  const logsUrl =
    logSecret !== undefined
      ? buildLogsUrl(origin, executionId, await signLogToken(logSecret, executionId))
      : undefined;

  const accepted = (): Response =>
    json(
      {
        executionId,
        ...(detailsUrl !== undefined ? { detailsUrl } : {}),
        ...(logsUrl !== undefined ? { logsUrl } : {}),
      },
      202,
    );

  // 6.5 Run cooldown (when the run declares one) — at most one execution per
  //     window per `{run}:{repo}:{scope}` bucket. A dispatch inside the window
  //     is acknowledged with the PRIOR execution's id and `skipped:
  //     "cooldown"`: 202, never an error, so a fire-and-forget CI step stays
  //     green and its `execution-id` output still points at a real execution.
  const cooldownVerdict = await checkAndArmCooldown({
    kv: env.IDEMPOTENCY_KV,
    runName: body.run,
    cooldown: run.cooldown,
    repo: body.github.repo,
    inputs,
    executionId,
    now: Date.now(),
  });
  if (cooldownVerdict.state === "cooling") {
    return json(
      {
        executionId: cooldownVerdict.priorExecutionId,
        skipped: "cooldown",
        retryAfterSec: cooldownVerdict.retryAfterSec,
      },
      202,
    );
  }

  // 7. Receiver-level dedup: write the KV entry FIRST (before touching
  //    Workflows) so a concurrent duplicate request sees the key and
  //    short-circuits. `put` with `expirationTtl` is idempotent — two
  //    racing writes both succeed; the second is a no-op on the same key.
  //    Without IDEMPOTENCY_KV, dedup falls back to CF Workflows'
  //    platform-level `create({id})` no-op (step 8).
  if (env.IDEMPOTENCY_KV !== undefined) {
    const existing = await env.IDEMPOTENCY_KV.get(executionId);
    if (existing !== null) {
      return accepted();
    }
    // Pre-record the dedup key so a concurrent request sees it.
    await env.IDEMPOTENCY_KV.put(executionId, executionId, {
      expirationTtl: IDEMPOTENCY_TTL_SEC,
    });
  }

  // 8. Build the Workflow `params` — exactly the `DispatchPayload` shape
  //    `RunWorkflow.run` decodes (apps/dispatcher/src/workflow.ts).
  //    `installation_id` (+ `pr_number` when present) ride along in `github`.
  const params = {
    executionId,
    run: body.run,
    github: {
      repo: body.github.repo,
      ref: body.github.ref,
      sha: body.github.sha,
      ...(body.github.installation_id !== undefined
        ? { installation_id: body.github.installation_id }
        : {}),
      ...(body.github.pr_number !== undefined
        ? { pr_number: body.github.pr_number }
        : {}),
    },
    inputs,
    // Forward completion-notify recipients (empty `emails` is dropped — the
    // Workflow treats absent + empty identically: no notification).
    ...(body.notify !== undefined && body.notify.emails.length > 0
      ? { notify: { emails: body.notify.emails } }
      : {}),
    // The dispatcher's public origin, so the run's artifact URLs come back
    // absolute (GitHub resolves a relative check-run link against github.com,
    // breaking it). `PUBLIC_ORIGIN` wins when set (a custom domain in front
    // of the Worker); otherwise the origin the caller actually dialed.
    origin: env.PUBLIC_ORIGIN ?? new URL(request.url).origin,
  };

  // CF Workflows rejects a `create({id})` whose id has been seen before with
  // `instance.already_exists` — including ids whose instances have since been
  // terminated. The dispatcher's idempotency contract is "same {run, repo,
  // sha} → same execution", so a duplicate create on a known id is the
  // intended end-state and we swallow it. Any other failure must propagate.
  try {
    await env.RUNS_WORKFLOW.create({ id: executionId, params });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (!/already_exists/i.test(msg)) throw cause;
  }

  // 9. KV entry was already written in step 7 (before the create call) to
  //    close the TOCTOU window. Return the execution id (+ dashboard link).
  return accepted();
};
