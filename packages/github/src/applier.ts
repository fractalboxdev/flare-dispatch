// FlareDispatch's effect applier for the check-run kinds (mameko specs/outbox.md
// § The applier port; specs/github-output.md § Check-run lifecycle, § Outbox).
// Every GitHub response becomes one closed answer; the drainer never sees a
// status code. Each kind is `adoptable`: `lookup` finds the check run by its
// `external_id`, the execution id, and reports whether the row's effect is on it.
import {
  AlarmPort,
  EffectApplier,
  type ApplyAnswer,
  type IntentRow,
  type LookupAnswer,
  type ReconcileAnswer,
} from "@fractalboxdev/mameko-ports";
import { Context, Effect, Layer, Match, Schema } from "effect";
import {
  GithubClient,
  type Annotation,
  type CheckRun,
  type GithubError,
  type RepoCall,
} from "./client.ts";
import {
  checkConclusion,
  ConcludeDetails,
  concludeSummary,
  truncate,
  Verdict,
} from "./conclusion.ts";

/** Which GitHub App installation serves a tenant scope; null when none does. */
export class InstallationDirectory extends Context.Service<
  InstallationDirectory,
  { readonly installationFor: (scopeId: string) => Effect.Effect<number | null, GithubError> }
>()("@fractalboxdev/flare-dispatch-github/InstallationDirectory") {}

// ---------------------------------------------------------------------------
// Payloads the profile's payload bindings build, one schema per kind

const CheckRef = {
  /** `flare-dispatch/<run>` or `flare-dispatch/<run>:<checkLabel>` (FD-GH-006). */
  name: Schema.String,
  head_sha: Schema.String,
  /** The log viewer URL with its capability token (FD-GH-013). */
  details_url: Schema.optionalKey(Schema.String),
};

const AnnotationSchema = Schema.Struct({
  path: Schema.String,
  start_line: Schema.Number,
  end_line: Schema.Number,
  annotation_level: Schema.Literals(["notice", "warning", "failure"]),
  message: Schema.String,
  title: Schema.optionalKey(Schema.String),
});

export const Payloads = {
  "check.open": Schema.Struct(CheckRef),
  "check.start": Schema.Struct({
    ...CheckRef,
    epoch: Schema.Number,
    executor_kind: Schema.String,
    attempt: Schema.Number,
  }),
  "check.progress": Schema.Struct({
    ...CheckRef,
    class: Schema.String,
    bucket: Schema.Literals(["1", "2–5", "6–20", "more than 20"]),
    deadline_at: Schema.Number,
  }),
  "check.conclude": Schema.Struct({
    ...CheckRef,
    verdict: Verdict,
    attempt: Schema.Number,
    details: ConcludeDetails,
  }),
  "check.summary": Schema.Struct({ ...CheckRef, title: Schema.String, markdown: Schema.String }),
  "check.annotations": Schema.Struct({
    ...CheckRef,
    title: Schema.String,
    summary: Schema.String,
    annotations: Schema.Array(AnnotationSchema),
  }),
} as const;

type CheckKind = keyof typeof Payloads;
type PayloadOf<K extends CheckKind> = (typeof Payloads)[K]["Type"];

/** GitHub takes at most 50 annotations per request (FD-GH-018). */
export const ANNOTATION_BATCH = 50;

const withAttempt = (title: string, attempt: number) =>
  attempt > 1 ? `${title} (attempt ${attempt})` : title;

const sameAnnotation = (a: Annotation, b: Annotation) =>
  a.path === b.path &&
  a.start_line === b.start_line &&
  a.end_line === b.end_line &&
  a.message === b.message;

const chunks = <A>(xs: readonly A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

/** One call into GitHub for one row: its installation, repository and execution. */
interface Ctx extends RepoCall {
  readonly executionId: string;
  readonly row: IntentRow;
}

interface Handler<K extends CheckKind> {
  readonly apply: (
    ctx: Ctx,
    payload: PayloadOf<K>,
    run: CheckRun | null,
  ) => Effect.Effect<ApplyAnswer, GithubError, GithubClient>;
  /** Whether the row's effect is visible on the check run an earlier attempt reached. */
  readonly adopted: (
    ctx: Ctx,
    payload: PayloadOf<K>,
    run: CheckRun,
  ) => Effect.Effect<boolean, GithubError, GithubClient>;
}

const applied = (run: CheckRun): ApplyAnswer => ({ _tag: "applied", externalRef: String(run.id) });
const notOpenYet: ApplyAnswer = { _tag: "retryable", reason: "check run not open yet" };
const afterConclusion: ApplyAnswer = {
  _tag: "refused",
  reason: "superseded: check run already completed",
};

const update = (
  ctx: Ctx,
  run: CheckRun,
  body: Parameters<GithubClient["Service"]["updateCheckRun"]>[0]["body"],
) =>
  Effect.gen(function* () {
    const github = yield* GithubClient;
    return applied(yield* github.updateCheckRun({ ...ctx, checkRunId: run.id, body }));
  });

const startOutput = (p: PayloadOf<"check.start">) => ({
  title: withAttempt(`Running on ${p.executor_kind}`, p.attempt),
  summary: `Executor kind \`${p.executor_kind}\`, epoch ${p.epoch}.`,
});

const progressOutput = (p: PayloadOf<"check.progress">) => ({
  title: `Queued: position ${p.bucket}`,
  summary: `Class \`${p.class}\`; queue position ${p.bucket}; deadline ${new Date(p.deadline_at).toISOString()}.`,
});

const concludeBody = (p: PayloadOf<"check.conclude">) => {
  const { conclusion, title } = checkConclusion(p.verdict);
  return {
    status: "completed" as const,
    conclusion,
    output: {
      title: withAttempt(title, p.attempt),
      summary: truncate(concludeSummary(p.verdict, p.details), p.details_url),
    },
  };
};

const missingAnnotations = (ctx: Ctx, p: PayloadOf<"check.annotations">, run: CheckRun) =>
  Effect.gen(function* () {
    const github = yield* GithubClient;
    const existing = yield* github.listAnnotations({ ...ctx, checkRunId: run.id });
    return p.annotations.filter((a) => !existing.some((e) => sameAnnotation(a, e)));
  });

const handlers: { readonly [K in CheckKind]: Handler<K> } = {
  "check.open": {
    // A repeat finds the run an earlier attempt created before it creates one (FD-GH-010).
    apply: (ctx, p, run) =>
      run !== null
        ? Effect.succeed(applied(run))
        : Effect.gen(function* () {
            const github = yield* GithubClient;
            const created = yield* github.createCheckRun({
              ...ctx,
              body: {
                name: p.name,
                head_sha: p.head_sha,
                external_id: ctx.executionId,
                status: "queued",
                ...(p.details_url === undefined ? {} : { details_url: p.details_url }),
              },
            });
            return applied(created);
          }),
    adopted: () => Effect.succeed(true),
  },
  "check.start": {
    apply: (ctx, p, run) => {
      if (run === null) return Effect.succeed(notOpenYet);
      if (run.status === "completed") return Effect.succeed(afterConclusion);
      return update(ctx, run, { status: "in_progress", output: startOutput(p) });
    },
    adopted: (_, p, run) =>
      Effect.succeed(run.status !== "queued" && run.output.summary === startOutput(p).summary),
  },
  "check.progress": {
    apply: (ctx, p, run) => {
      if (run === null) return Effect.succeed(notOpenYet);
      if (run.status === "completed") return Effect.succeed(afterConclusion);
      return update(ctx, run, { output: progressOutput(p) });
    },
    adopted: (_, p, run) => Effect.succeed(run.output.title === progressOutput(p).title),
  },
  "check.conclude": {
    // Without an applied `check.open`, the conclusion creates the check run completed (FD-GH-052).
    apply: (ctx, p, run) =>
      run !== null
        ? update(ctx, run, concludeBody(p))
        : Effect.gen(function* () {
            const github = yield* GithubClient;
            const created = yield* github.createCheckRun({
              ...ctx,
              body: {
                name: p.name,
                head_sha: p.head_sha,
                external_id: ctx.executionId,
                ...(p.details_url === undefined ? {} : { details_url: p.details_url }),
                ...concludeBody(p),
              },
            });
            return applied(created);
          }),
    adopted: (_, p, run) =>
      Effect.succeed(run.status === "completed" && run.conclusion === concludeBody(p).conclusion),
  },
  "check.summary": {
    apply: (ctx, p, run) =>
      run === null
        ? Effect.succeed(notOpenYet)
        : update(ctx, run, {
            output: { title: p.title, summary: truncate(p.markdown, p.details_url) },
          }),
    adopted: (_, p, run) => Effect.succeed(run.output.title === p.title),
  },
  "check.annotations": {
    // Annotations are read back by check-run id first, so a repeat sends only the missing ones.
    apply: (ctx, p, run) =>
      run === null
        ? Effect.succeed(notOpenYet)
        : Effect.gen(function* () {
            const github = yield* GithubClient;
            const missing = yield* missingAnnotations(ctx, p, run);
            // The run's own title and summary stay, so a batch never overwrites a conclusion's output.
            const output = {
              title: run.output.title ?? p.title,
              summary: run.output.summary ?? p.summary,
            };
            for (const batch of chunks(missing, ANNOTATION_BATCH))
              yield* github.updateCheckRun({
                ...ctx,
                checkRunId: run.id,
                body: { output: { ...output, annotations: batch } },
              });
            return applied(run);
          }),
    adopted: (ctx, p, run) => Effect.map(missingAnnotations(ctx, p, run), (m) => m.length === 0),
  },
};

const isCheckKind = (kind: string): kind is CheckKind => Object.hasOwn(handlers, kind);

/** A GitHub error as the closed answer of `apply` (FD-GH-045, FD-GH-046, MAMEKO-OUT-016 to MAMEKO-OUT-018). */
export const classify = (e: GithubError): ApplyAnswer =>
  Match.value(e).pipe(
    Match.tag("GithubNetworkError", ({ sent, message }): ApplyAnswer =>
      sent
        ? { _tag: "unknown", reason: `network: ${message}` }
        : { _tag: "retryable", reason: `network: ${message}` },
    ),
    Match.tag("GithubHttpError", ({ status, message, rateLimited }): ApplyAnswer => {
      if (status === 401) return { _tag: "refused", reason: "installation: unauthorized" };
      if (status >= 500 || status === 429 || (status === 403 && rateLimited))
        return { _tag: "retryable", reason: `github ${status}: ${message}` };
      return { _tag: "refused", reason: `github ${status}: ${message}` };
    }),
    Match.exhaustive,
  );

/** The row is answered before any GitHub call: a refusal or a missing installation. */
class Answered extends Schema.TaggedError<Answered>()("Answered", { answer: Schema.Unknown }) {}
const answered = (answer: ApplyAnswer) => Effect.fail(new Answered({ answer }));

const reasonOf = (e: GithubError): string =>
  Match.value(e).pipe(
    Match.tag("GithubNetworkError", ({ message }) => `network: ${message}`),
    Match.tag("GithubHttpError", ({ status, message }) => `github ${status}: ${message}`),
    Match.exhaustive,
  );

/** More than one check run carries the execution id. */
class AmbiguousCheckRun extends Schema.TaggedError<AmbiguousCheckRun>()("AmbiguousCheckRun", {
  count: Schema.Number,
}) {}

const found = (run: CheckRun | null): LookupAnswer =>
  run === null ? { _tag: "absent" } : { _tag: "found", externalRef: String(run.id) };

export const CheckRunApplierLive = Layer.effect(
  EffectApplier,
  Effect.gen(function* () {
    const github = yield* GithubClient;
    const directory = yield* InstallationDirectory;
    const alarms = yield* AlarmPort;

    const raiseInstallationLost = (row: IntentRow, reason: string) =>
      alarms
        .deliver({
          name: "installation-lost",
          severity: "page",
          dedupeKey: `installation-lost:${row.scopeId}`,
          state: "raised",
          detail: { scopeId: row.scopeId, kind: row.kind, reason },
        })
        // A failed alarm delivery is logged; it never changes the row's answer.
        .pipe(
          Effect.catchTag("AlarmDeliveryFailed", (e) =>
            Effect.logWarning("alarm not delivered", e.reason),
          ),
        );

    /** One `401` mints a new token and retries once (FD-GH-047). */
    const call = <A>(installation: number, effect: Effect.Effect<A, GithubError, GithubClient>) =>
      effect.pipe(
        Effect.catchTag("GithubHttpError", (e) =>
          e.status === 401
            ? Effect.andThen(github.refreshToken(installation), effect)
            : Effect.fail(e),
        ),
        Effect.provideService(GithubClient, github),
      );

    const resolve = (row: IntentRow) =>
      Effect.gen(function* () {
        const executionId = row.executionId;
        if (executionId === null)
          return yield* answered({
            _tag: "refused",
            reason: "a check-run kind belongs to an execution",
          });
        const kind = row.kind;
        if (!isCheckKind(kind))
          return yield* answered({
            _tag: "refused",
            reason: `applier: ${kind} is not a check-run kind`,
          });
        const payload = yield* Schema.decodeUnknownEffect(Payloads[kind])(row.payload).pipe(
          Effect.catchTag("SchemaError", (e) =>
            answered({ _tag: "refused", reason: `payload: ${e.message}` }),
          ),
        );
        const installation = yield* directory.installationFor(row.scopeId);
        if (installation === null) {
          yield* raiseInstallationLost(row, "installation: not found");
          return yield* answered({ _tag: "refused", reason: "installation: not found" });
        }
        const ctx: Ctx = { installation, repo: row.scopeId, executionId, row };
        // The handler table is keyed by kind, and the payload decoded under that kind's schema.
        const handler = handlers[kind] as unknown as Handler<CheckKind>;
        // Every check run of the execution, oldest first; more than one means an earlier create was doubled.
        const matching = call(
          installation,
          Effect.map(
            github.listCheckRuns({ ...ctx, ref: payload.head_sha, name: payload.name }),
            (runs) => runs.filter((r) => r.external_id === executionId).sort((a, b) => a.id - b.id),
          ),
        );
        return { ctx, kind, matching, payload: payload as never, handler };
      });

    const apply = (row: IntentRow): Effect.Effect<ApplyAnswer> =>
      Effect.gen(function* () {
        const { ctx, kind, matching, payload, handler } = yield* resolve(row);
        // A first attempt of `check.open` creates at once. Every later attempt searches by `external_id`
        // before it writes, and works on the oldest check run it finds (FD-GH-010, FD-GH-044).
        const run =
          kind === "check.open" && row.attempts === 0 ? null : ((yield* matching)[0] ?? null);
        return yield* call(ctx.installation, handler.apply(ctx, payload, run));
      }).pipe(
        Effect.catchTags({
          Answered: (e) => Effect.succeed(e.answer as ApplyAnswer),
          GithubHttpError: (e) =>
            e.status === 401
              ? Effect.as(raiseInstallationLost(row, "installation: unauthorized"), classify(e))
              : Effect.succeed(classify(e)),
          GithubNetworkError: (e) => Effect.succeed(classify(e)),
        }),
      );

    /**
     * The check run carrying the row's effect, or null when the effect is not on GitHub. A read that fails, or
     * finds the execution's check run more than once, proves neither.
     */
    const adoptedRun = (
      row: IntentRow,
    ): Effect.Effect<CheckRun | null, GithubError | AmbiguousCheckRun> =>
      Effect.gen(function* () {
        const { ctx, matching, payload, handler } = yield* resolve(row);
        const runs = yield* matching;
        if (runs.length > 1)
          return yield* Effect.fail(new AmbiguousCheckRun({ count: runs.length }));
        const run = runs[0];
        if (run === undefined) return null;
        return (yield* call(ctx.installation, handler.adopted(ctx, payload, run))) ? run : null;
      }).pipe(Effect.catchTag("Answered", () => Effect.succeed(null)));

    // Neither read guesses: a failed or ambiguous read answers `undetermined`, the row stays ambiguous and the
    // drainer asks again after back-off (MAMEKO-OUT-025, MAMEKO-OUT-064).
    const undetermined = (e: GithubError | AmbiguousCheckRun) =>
      e instanceof AmbiguousCheckRun ? `check run: ${e.count} carry the execution id` : reasonOf(e);

    return {
      apply,
      lookup: (row) =>
        adoptedRun(row).pipe(
          Effect.match({
            onFailure: (e): LookupAnswer => ({ _tag: "undetermined", reason: undetermined(e) }),
            onSuccess: found,
          }),
        ),
      reconcile: (row) =>
        adoptedRun(row).pipe(
          Effect.match({
            onFailure: (e): ReconcileAnswer => ({ _tag: "undetermined", reason: undetermined(e) }),
            onSuccess: found,
          }),
        ),
    };
  }),
);
