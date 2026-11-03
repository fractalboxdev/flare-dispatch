// `POST /v1/dispatch/:run`: identity before any run lookup, then the body bound,
// the run, the body and input schemas, the repository binding, the signals caps,
// the installation, the manifest and the commit, then one admission request
// (specs/intake.md § Actions dispatch, specs/interfaces.md FD-IFC-024 to FD-IFC-036).
import { GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { Context, Effect, Option, Schema } from "effect";
import { IntakeConfig, intakeError, type IntakeError } from "./config.ts";
import { validIdempotencyKey } from "./dedup.ts";
import type { Caller } from "./event.ts";
import { json, parseJson, readBody } from "./http.ts";
import { OidcVerifier } from "./oidc.ts";
import { readManifest, viewOf } from "./triggers.ts";
import type { IntakeRun } from "./runs.ts";
import { submission, submit } from "./submit.ts";

export const DISPATCH_MAX_BYTES = 1024 * 1024;

/** The `signals/v1` caps (FD-INT-049, FD-IFC-030). */
export const SIGNAL_CAPS = {
  entries: 50,
  source: 120,
  title: 200,
  detail: 2000,
  url: 1000,
} as const;

/** The Access identity gate of the HTTP API: the verified identity of the request, or null when it carries none. */
export class AccessIdentity extends Context.Service<
  AccessIdentity,
  { readonly identity: (request: Request) => Effect.Effect<string | null> }
>()("@fractalboxdev/flare-dispatch-intake/AccessIdentity") {}

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Label = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/));

export const DispatchBody = Schema.Struct({
  /** `<owner>/<repo>`; an Actions token's `repository` claim binds it (FD-INT-036). */
  repository: Schema.optionalKey(Schema.NonEmptyString),
  ref: Schema.optionalKey(Schema.NonEmptyString),
  sha: Schema.optionalKey(Sha),
  label: Schema.optionalKey(Label),
  inputs: Schema.optionalKey(Schema.Unknown),
  class: Schema.optionalKey(Schema.NonEmptyString),
  installation_id: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  signals: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
export type DispatchBody = typeof DispatchBody.Type;

const Signal = Schema.Struct({
  source: Schema.String.check(Schema.isMaxLength(SIGNAL_CAPS.source)),
  title: Schema.String.check(Schema.isMaxLength(SIGNAL_CAPS.title)),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(SIGNAL_CAPS.detail))),
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(SIGNAL_CAPS.url))),
});

/** The input's own `signals` merged with the body's, within the `signals/v1` caps. */
export const checkSignals = (body: readonly unknown[] | undefined, inputs: unknown) => {
  const collected =
    inputs !== null &&
    typeof inputs === "object" &&
    Array.isArray((inputs as { signals?: unknown }).signals)
      ? ((inputs as { signals: unknown[] }).signals as readonly unknown[])
      : [];
  const merged = [...collected, ...(body ?? [])];
  if (merged.length > SIGNAL_CAPS.entries)
    return Effect.fail(
      intakeError(
        400,
        "invalid_signals",
        `${merged.length} signals; at most ${SIGNAL_CAPS.entries}`,
      ),
    );
  return Schema.decodeUnknownEffect(Schema.Array(Signal))(merged).pipe(
    Effect.mapError((e) => intakeError(400, "invalid_signals", e.message)),
    Effect.asVoid,
  );
};

interface Identified {
  readonly caller: Caller;
  /** The Actions token's claims, which bind the repository, ref and commit. */
  readonly claims: {
    readonly repository: string;
    readonly ref?: string;
    readonly sha?: string;
  } | null;
}

const peekIssuer = (token: string) => {
  try {
    const claims = JSON.parse(
      atob((token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/")),
    ) as { iss?: unknown };
    return typeof claims.iss === "string" ? claims.iss : null;
  } catch {
    return null;
  }
};

/** An Actions OIDC token or an Access identity in `dispatchers`, else `401` (FD-INT-034, FD-IFC-027). */
const identify = (
  request: Request,
): Effect.Effect<Identified, IntakeError, IntakeConfig | OidcVerifier | AccessIdentity> =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const unauthenticated = intakeError(
      401,
      "unauthenticated",
      "a dispatch carries an Actions OIDC token or the Access identity of a dispatcher",
    );
    const header = request.headers.get("authorization");
    const bearer = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : null;
    if (bearer !== null && peekIssuer(bearer) === "https://token.actions.githubusercontent.com") {
      if (config.oidcAudience === undefined) return yield* Effect.fail(unauthenticated);
      const claims = yield* (yield* OidcVerifier)
        .verify(bearer, config.oidcAudience)
        .pipe(Effect.mapError(() => unauthenticated));
      return {
        caller: {
          kind: "actions-oidc",
          id: claims.sub,
          ...(claims.workflow_ref === undefined ? {} : { workflowRef: claims.workflow_ref }),
        },
        claims,
      } satisfies Identified;
    }
    const identity = yield* (yield* AccessIdentity).identity(request);
    if (identity === null || !config.dispatchers.includes(identity))
      return yield* Effect.fail(unauthenticated);
    return { caller: { kind: "access", id: identity }, claims: null } satisfies Identified;
  });

const decodeOr =
  <S extends Schema.Decoder<unknown>>(schema: S, code: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((e) => intakeError(400, code, e.message)),
    );

const branchOf = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/** The run as the repository's manifest lists it for `dispatch`, or `404 run_not_found` (FD-INT-015, FD-IFC-028). */
const listedEntry = (run: IntakeRun, repo: string, label: string | null, defaultBranch: string) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const notListed = intakeError(
      404,
      "run_not_found",
      `${repo}'s manifest lists no dispatch of ${run.name}`,
    );
    const head = yield* github.branchHead(repo, defaultBranch);
    const manifest = yield* readManifest(repo, head);
    if (Option.isNone(manifest)) return yield* Effect.fail(notListed);
    const entry = manifest.value.runs.find(
      (e) =>
        e.recipe === run.name &&
        (e.label ?? null) === label &&
        e.triggers.includes("dispatch") &&
        config.allows(repo, run.name),
    );
    if (entry === undefined) return yield* Effect.fail(notListed);
    return viewOf(entry);
  });

const readFailure = (e: { readonly _tag: string; readonly message?: string }) =>
  intakeError(
    503,
    "unavailable",
    `GitHub read failed: ${e._tag}${e.message === undefined ? "" : `: ${e.message}`}`,
  );

/** The dispatch route for one run name. */
export const handleDispatch = (runName: string, request: Request) =>
  Effect.gen(function* () {
    const { caller, claims } = yield* identify(request);
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const bytes = yield* readBody(request, DISPATCH_MAX_BYTES);
    const run = config.catalog(runName);
    if (run === undefined)
      return yield* Effect.fail(intakeError(404, "run_not_found", `no run named ${runName}`));
    const idemHeader = request.headers.get("idempotency-key");
    if (idemHeader !== null && !validIdempotencyKey(idemHeader))
      return yield* Effect.fail(
        intakeError(
          400,
          "invalid_idempotency_key",
          "an Idempotency-Key is 1 to 128 characters of [A-Za-z0-9._:-]",
        ),
      );
    const raw = yield* parseJson(bytes);
    const body = yield* decodeOr(DispatchBody, "invalid_body")(raw);
    const repo = claims?.repository ?? body.repository;
    if (repo === undefined)
      return yield* Effect.fail(
        intakeError(400, "invalid_body", "repository: a dispatch names a repository"),
      );
    if (claims !== null && body.repository !== undefined && body.repository !== claims.repository)
      return yield* Effect.fail(
        intakeError(
          403,
          "repository_mismatch",
          `the token is for ${claims.repository}, not ${body.repository}`,
        ),
      );
    const inputs = yield* decodeOr(run.input, "invalid_inputs")(body.inputs ?? {});
    yield* checkSignals(body.signals, body.inputs);

    const installation =
      body.installation_id ??
      (yield* github
        .installation(repo)
        .pipe(
          Effect.catchTag("GithubUncredentialed", () =>
            Effect.fail(
              intakeError(
                422,
                "installation_not_found",
                `no installation of the GitHub App covers ${repo}`,
              ),
            ),
          ),
        ));
    const label = body.label ?? null;
    const defaultBranch = yield* github.defaultBranch(repo);
    yield* listedEntry(run, repo, label, defaultBranch);
    const ref = body.ref ?? claims?.ref ?? `refs/heads/${defaultBranch}`;
    // A dispatch with no ref pins the default branch head at intake (FD-INT-041).
    const sha =
      body.sha ??
      (body.ref === undefined ? claims?.sha : undefined) ??
      (yield* github.branchHead(repo, branchOf(ref)));
    const admitted = yield* submit(
      submission({
        run,
        trigger: "dispatch",
        label,
        repo,
        sha,
        ref,
        inputs,
        installation,
        caller,
        classInput: body.class ?? null,
        idempotency: idemHeader === null ? null : { key: idemHeader, body: raw },
      }),
    );
    const base = new URL(request.url).origin;
    return json(
      {
        execution_id: admitted.executionId,
        class: admitted.className,
        details_url: `${base}/v1/executions/${admitted.executionId}`,
        logs_url: `${base}/v1/executions/${admitted.executionId}/logs`,
        ...(admitted.duplicate ? { duplicate: true } : {}),
      },
      202,
    );
  }).pipe(
    Effect.catchTags({
      GithubHttpError: (e) => Effect.fail(readFailure(e)),
      GithubNetworkError: (e) => Effect.fail(readFailure(e)),
      GithubUnexpected: (e) => Effect.fail(readFailure(e)),
      GithubUncredentialed: () =>
        Effect.fail(
          intakeError(
            422,
            "installation_not_found",
            "no installation of the GitHub App covers the repository",
          ),
        ),
    }),
  );
