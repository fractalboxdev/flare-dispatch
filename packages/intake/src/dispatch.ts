// The admission of an authenticated dispatch: the run, the input schema, the signals caps, the installation, the
// manifest and the commit, then one admission request (specs/intake.md § Actions dispatch). The HTTP API's declared
// dispatch route authenticates the caller and decodes the body (specs/interfaces.md FD-IFC-024 to FD-IFC-036).
import { GithubRead, type PullSummary } from "@fractalboxdev/flare-dispatch-github";
import { classNamed } from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Match, Option, Schema } from "effect";
import { ClassResolver, IntakeConfig, intakeError } from "./config.ts";
import type { Caller } from "./event.ts";
import { readManifest, requiredCheckFact, viewOf } from "./triggers.ts";
import { callerInputOf, checkName, type IntakeRun } from "./runs.ts";
import { submission, submit } from "./submit.ts";

/** The `signals/v1` caps (FD-INT-049, FD-IFC-030). */
export const SIGNAL_CAPS = {
  entries: 50,
  source: 120,
  title: 200,
  detail: 2000,
  url: 1000,
} as const;

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

const decodeOr =
  <S extends Schema.Decoder<unknown>>(schema: S, code: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((e) => intakeError(400, code, e.message)),
    );

const branchOf = (ref: string) =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

/** The run as the repository's manifest lists it for the trigger, or `404 run_not_found` (FD-INT-015, FD-IFC-028). */
const listedEntry = (
  run: IntakeRun,
  repo: string,
  label: string | null,
  defaultBranch: string,
  trigger: AuthenticatedDispatch["trigger"],
) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const notListed = intakeError(
      404,
      "run_not_found",
      `${repo}'s manifest lists no ${trigger} of ${run.name}`,
    );
    const head = yield* github.branchHead(repo, defaultBranch);
    const manifest = yield* readManifest(repo, head);
    if (Option.isNone(manifest)) return yield* Effect.fail(notListed);
    const entry = manifest.value.runs.find(
      (e) =>
        e.recipe === run.name &&
        (e.label ?? null) === label &&
        e.triggers.includes(trigger) &&
        config.allows(repo, run.name),
    );
    if (entry === undefined) return yield* Effect.fail(notListed);
    return viewOf(entry, manifest.value);
  });

const readFailure = (e: { readonly _tag: string; readonly message?: string }) =>
  intakeError(
    503,
    "unavailable",
    `GitHub read failed: ${e._tag}${e.message === undefined ? "" : `: ${e.message}`}`,
  );

/** Whether `a` ranks above `b`: a lower rank number is a higher class. */
const ranksAbove = (ranks: (name: string) => number | undefined, a: string, b: string) => {
  const ra = ranks(a);
  const rb = ranks(b);
  return ra !== undefined && rb !== undefined && ra < rb;
};

/**
 * An MCP call's class input, lower-only: a class above the one `resolveClass` assigns without it is dropped, so the
 * call runs at the assigned class, and the clamp is logged (FD-INT-063).
 */
export const lowerOnlyClass = (r: {
  readonly run: IntakeRun;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly defaultBranch: string;
  readonly label: string | null;
  readonly caller: Caller;
  readonly requested: string | null;
  readonly classCeiling: string | null;
}) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const assigned = yield* (yield* ClassResolver).resolve({
      run: r.run,
      trigger: "mcp",
      event: null,
      repo: r.repo,
      ref: r.ref,
      sha: r.sha,
      defaultBranch: r.defaultBranch,
      targetBranch: null,
      refProtection: null,
      checkName: checkName(r.run.name, r.label),
      classInput: null,
      classCeiling: r.classCeiling,
      caller: r.caller,
    });
    const ranks = (name: string) => classNamed(config.profile, name)?.rank;
    const requested = r.requested;
    return yield* Match.value(assigned).pipe(
      Match.tag("Fail", () => Effect.succeed(requested)),
      Match.tag("Class", ({ class: given }) =>
        requested !== null && ranksAbove(ranks, requested, given)
          ? Effect.as(
              Effect.logInfo("mcp dispatch class clamped", {
                requested,
                assigned: given,
                caller: r.caller.id,
              }),
              null,
            )
          : Effect.succeed(requested),
      ),
      Match.exhaustive,
    );
  });

/**
 * The branch the pull request a run's inputs name targets, for a run that reads the required set; null when the inputs
 * name none, the pull request is not among the 100 most recently updated open ones, or the read fails.
 */
const pullTargetBranch = (run: IntakeRun, repo: string, inputs: unknown) =>
  Effect.gen(function* () {
    if (run.requiredCheck === undefined) return null;
    const number = run.pullNumber?.(inputs) ?? null;
    if (number === null) return null;
    const pulls = yield* (yield* GithubRead).openPulls(repo).pipe(
      Effect.catch((e) =>
        Effect.as(
          Effect.logWarning("open pull requests unreadable; the target branch is unknown", {
            repo,
            reason: e._tag,
          }),
          [] as readonly PullSummary[],
        ),
      ),
    );
    return pulls.find((p) => p.number === number)?.base.ref ?? null;
  });

/**
 * A dispatch whose caller is already authenticated and whose body is decoded, as the HTTP API's declared dispatch
 * route hands it to `admitDispatch`.
 */
export interface AuthenticatedDispatch {
  readonly trigger: "dispatch" | "mcp";
  readonly run: string;
  readonly repository: string;
  /** The ref to run; undefined runs the repository's default branch. */
  readonly ref: string | undefined;
  /** The commit to run; undefined pins the head of `ref` at intake (FD-INT-041). */
  readonly sha: string | undefined;
  readonly label: string | null;
  readonly inputs: unknown;
  readonly signals: readonly unknown[] | undefined;
  readonly classInput: string | null;
  /** The `classCeiling` of the caller's `dispatch.scoped` entry (FD-IFC-091); null for a caller in no entry. */
  readonly classCeiling: string | null;
  readonly caller: Caller;
  /** The commit an Actions OIDC token vouches for; any other commit must be the head of a branch of the repository. */
  readonly vouchedSha: string | undefined;
  /** A validated `Idempotency-Key` and the body it covers (FD-INT-010). */
  readonly idempotency: { readonly key: string; readonly body: unknown } | null;
}

export interface DispatchAdmitted {
  readonly executionId: string;
  readonly className: string;
  readonly duplicate: boolean;
}

/**
 * The run, the input schema, the signals caps, the installation, the manifest and the commit of an authenticated
 * dispatch, then one admission request. Every refusal carries a code of the error-model table (FD-IFC-009). A
 * dispatch of a read-only scan run carries an `Idempotency-Key`, or answers 400 `invalid_idempotency_key` before any
 * read (FD-IFC-092), over the HTTP route and the MCP `dispatch` tool alike (FD-IFC-074). A scoped dispatcher's
 * `classCeiling` reaches `resolveClass` (FD-IFC-091). The inputs pass the run's caller schema, which refuses a
 * `release-notes` publish with 400 `invalid_inputs` (FD-INT-066).
 */
export const admitDispatch = (d: AuthenticatedDispatch) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const github = yield* GithubRead;
    const run = config.catalog(d.run);
    if (run === undefined)
      return yield* Effect.fail(intakeError(404, "run_not_found", `no run named ${d.run}`));
    if (run.readOnlyScan === true && d.idempotency === null)
      return yield* Effect.fail(
        intakeError(
          400,
          "invalid_idempotency_key",
          `a dispatch of the read-only scan run ${run.name} carries an Idempotency-Key`,
        ),
      );
    const repo = d.repository;
    // A caller's inputs pass the run's caller schema, so a `release-notes` publish never starts from a dispatch or an
    // MCP call: only a release approval builds one (FD-INT-066).
    const decoded = yield* decodeOr(callerInputOf(run), "invalid_inputs")(d.inputs ?? {});
    yield* checkSignals(d.signals, d.inputs);

    // The App's own installation for the repository decides (FD-INT-042).
    const installation = yield* github.installation(repo);
    const defaultBranch = yield* github.defaultBranch(repo);
    yield* listedEntry(run, repo, d.label, defaultBranch, d.trigger);
    const ref = d.ref ?? `refs/heads/${defaultBranch}`;
    // A dispatch with no commit pins the head of its ref at intake (FD-INT-041).
    const sha = d.sha ?? (yield* github.branchHead(repo, branchOf(ref)));
    // An Actions token vouches for one commit. Any other commit it names must be the head of a branch of this
    // repository; otherwise a workflow could dispatch a fork's commit as trusted, outside the fork-pr trigger.
    if (d.vouchedSha !== undefined && d.sha !== undefined && d.sha !== d.vouchedSha) {
      const branchSha = ref.startsWith("refs/heads/")
        ? yield* github.branchHead(repo, branchOf(ref))
        : undefined;
      if (branchSha !== sha)
        return yield* Effect.fail(
          intakeError(
            403,
            "forbidden",
            `the token vouches for ${d.vouchedSha}; ${sha} is not the head of a branch ${ref} of ${repo}`,
          ),
        );
    }
    const classInput =
      d.trigger === "mcp"
        ? yield* lowerOnlyClass({
            run,
            repo,
            ref,
            sha,
            defaultBranch,
            label: d.label,
            caller: d.caller,
            requested: d.classInput,
            classCeiling: d.classCeiling,
          })
        : d.classInput;
    // Intake's own required-set fact replaces any the caller sent, whatever the trigger (FD-AGT-092, FD-AGT-093).
    const inputs = yield* requiredCheckFact(
      repo,
      yield* pullTargetBranch(run, repo, decoded),
      run,
      d.label,
      decoded,
    );
    const admitted = yield* submit(
      submission({
        run,
        trigger: d.trigger,
        label: d.label,
        repo,
        sha,
        ref,
        inputs,
        installation,
        caller: d.caller,
        classInput,
        classCeiling: d.classCeiling,
        idempotency: d.idempotency,
      }),
    );
    return {
      executionId: admitted.executionId,
      className: admitted.className,
      duplicate: admitted.duplicate,
    } satisfies DispatchAdmitted;
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
