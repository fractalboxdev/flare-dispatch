// FlareDispatch's applier for the check-run kinds, an actuator in mameko's sense (mameko specs/outbox.md
// § The actuator port and the actuator rate limit; specs/github-output.md § Check-run lifecycle, § Outbox).
// Every GitHub response becomes one closed answer; the drainer never sees a
// status code. Each kind is `adoptable`: `lookup` finds the check run by its
// `external_id`, the execution id, and reports whether the row's effect is on it.
import {
  Actuators,
  actuatorRegistry,
  AlarmPort,
  type Actuator,
  type ApplyAnswer,
  type IntentRow,
  type LookupAnswer,
  type ReconcileAnswer,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer, Match, Option, Schema } from "effect";
import {
  GithubClient,
  type Annotation,
  type CheckRun,
  type GithubError,
  type RepoCall,
} from "./client.ts";
import { ConcludeFacts, type ConcludeFactsUnavailable } from "./conclude-facts.ts";
import {
  checkConclusion,
  checkNeutralInvariant,
  ConcludeDetails,
  concludedVerdictOf,
  concludeSummary,
  OutcomePayload,
  quarantineAnnotations,
  truncate,
  Verdict,
} from "./conclusion.ts";
import { InstallationDirectory } from "./directory.ts";

export { InstallationDirectory };

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

/** The payload of the `cp:check:conclude` row a fan-out parent's outcome inserts for a child (FD-GH-020). */
export const ChildVerdictPayload = Schema.Struct({ verdict: Verdict });

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
  /** The outcome the execution row records, for a conclusion built from mameko's outcome row. */
  readonly recorded: Verdict | null;
}

interface Handler<K extends CheckKind> {
  readonly apply: (
    ctx: Ctx,
    payload: PayloadOf<K>,
    run: CheckRun | null,
  ) => Effect.Effect<ApplyAnswer, GithubError, GithubClient | AlarmPort>;
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

const concludeOutput = (p: PayloadOf<"check.conclude">) => ({
  title: withAttempt(checkConclusion(p.verdict).title, p.attempt),
  summary: truncate(concludeSummary(p.verdict, p.details), p.details_url),
});

const detailsUrl = (p: { readonly details_url?: string }) =>
  p.details_url === undefined ? {} : { details_url: p.details_url };

/**
 * The conclusion with the log link and the first batch of quarantined-failure annotations (FD-GH-013, FD-GH-077). The
 * link is sent again, so the check run carries the token minted at its conclusion.
 */
const concludeBody = (p: PayloadOf<"check.conclude">) => {
  const first = quarantineAnnotations(p.details).slice(0, ANNOTATION_BATCH);
  return {
    ...detailsUrl(p),
    status: "completed" as const,
    conclusion: checkConclusion(p.verdict).conclusion,
    output: { ...concludeOutput(p), ...(first.length === 0 ? {} : { annotations: first }) },
  };
};

/** The quarantined-failure annotations beyond the first batch, 50 per request, keeping the conclusion's output. */
const restOfQuarantine = (ctx: Ctx, p: PayloadOf<"check.conclude">, run: CheckRun) =>
  Effect.gen(function* () {
    const github = yield* GithubClient;
    for (const batch of chunks(
      quarantineAnnotations(p.details).slice(ANNOTATION_BATCH),
      ANNOTATION_BATCH,
    ))
      yield* github.updateCheckRun({
        ...ctx,
        checkRunId: run.id,
        body: { output: { ...concludeOutput(p), annotations: batch } },
      });
    return applied(run);
  });

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
                ...detailsUrl(p),
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
    // Without an applied `check.open`, the conclusion creates the check run completed (FD-GH-052). The conclusion
    // GitHub answers is held against the execution's recorded outcome (FD-GH-031).
    apply: (ctx, p, run) =>
      Effect.gen(function* () {
        const github = yield* GithubClient;
        const concluded =
          run !== null
            ? yield* github.updateCheckRun({ ...ctx, checkRunId: run.id, body: concludeBody(p) })
            : yield* github.createCheckRun({
                ...ctx,
                body: {
                  name: p.name,
                  head_sha: p.head_sha,
                  external_id: ctx.executionId,
                  ...concludeBody(p),
                },
              });
        yield* checkNeutralInvariant(
          ctx.executionId,
          ctx.row.scopeId,
          concluded.conclusion,
          ctx.recorded ?? p.verdict,
        );
        return yield* restOfQuarantine(ctx, p, concluded);
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

/** The row cannot reach GitHub: a kind this applier does not serve, a bad payload or a missing installation. */
class Unservable extends Schema.TaggedError<Unservable>()("Unservable", {
  reason: Schema.String,
}) {}
const unservable = (reason: string) => Effect.fail(new Unservable({ reason }));

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

type ReadFailure = GithubError | AmbiguousCheckRun | Unservable | ConcludeFactsUnavailable;

const found = (run: CheckRun | null): LookupAnswer =>
  run === null ? { _tag: "absent" } : { _tag: "found", externalRef: String(run.id) };

/** The check-run applier's service, for `CheckRunApplierLive` and the applier that routes every GitHub kind. */
export const makeCheckRunApplier = Effect.gen(function* () {
  const github = yield* GithubClient;
  const directory = yield* InstallationDirectory;
  const alarms = yield* AlarmPort;
  const facts = yield* ConcludeFacts;

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

  /**
   * The `check.conclude` payload. The outcome row mameko's terminal write inserts carries `{ outcome }`; its verdict is
   * `verdictOf(outcome)`, and a child the parent-ended cascade cancelled concludes `failure` "parent closed before this
   * part settled" (FD-GH-020). The `cp:check:conclude` row a fan-out parent's outcome inserts for a child carries
   * `{ verdict }` (FD-GH-020). Either way the name, head SHA, attempt, summary facts and log link come from the
   * execution's records (FD-GH-008, FD-GH-013, FD-GH-014, FD-GH-015). A row that carries the whole payload is taken as
   * it is.
   */
  const concludePayload = (executionId: string, payload: unknown) =>
    Effect.gen(function* () {
      const given = Schema.decodeUnknownOption(Payloads["check.conclude"])(payload);
      if (Option.isSome(given)) return { payload: given.value, recorded: null };
      const child = Schema.decodeUnknownOption(ChildVerdictPayload)(payload);
      const verdict = Option.isSome(child)
        ? child.value.verdict
        : concludedVerdictOf(
            (yield* Schema.decodeUnknownEffect(OutcomePayload)(payload).pipe(
              Effect.catchTag("SchemaError", (e) => unservable(`payload: ${e.message}`)),
            )).outcome,
          );
      const known = yield* facts.of(executionId);
      if (known === null) return yield* unservable("conclude: no record of the execution");
      const built: PayloadOf<"check.conclude"> = {
        name: known.name,
        head_sha: known.headSha,
        ...(known.detailsUrl === undefined ? {} : { details_url: known.detailsUrl }),
        verdict,
        attempt: known.attempt,
        details: known.details,
      };
      return { payload: built, recorded: known.recorded };
    });

  const decode = (kind: CheckKind, executionId: string, payload: unknown) =>
    kind === "check.conclude"
      ? concludePayload(executionId, payload)
      : Effect.map(
          Schema.decodeUnknownEffect(Payloads[kind])(payload).pipe(
            Effect.catchTag("SchemaError", (e) => unservable(`payload: ${e.message}`)),
          ),
          (decoded) => ({ payload: decoded, recorded: null }),
        );

  const resolve = (row: IntentRow) =>
    Effect.gen(function* () {
      const executionId = row.executionId;
      if (executionId === null)
        return yield* unservable("a check-run kind belongs to an execution");
      const kind = row.kind;
      if (!isCheckKind(kind)) return yield* unservable(`applier: ${kind} is not a check-run kind`);
      const { payload, recorded } = yield* decode(kind, executionId, row.payload);
      const installation = yield* directory.installationFor(row.scopeId);
      if (installation === null) {
        yield* raiseInstallationLost(row, "installation: not found");
        return yield* unservable("installation: not found");
      }
      const ctx: Ctx = { installation, repo: row.scopeId, executionId, row, recorded };
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
      return { ctx, matching, payload: payload as never, handler };
    });

  const apply = (row: IntentRow): Effect.Effect<ApplyAnswer> =>
    Effect.gen(function* () {
      const { ctx, matching, payload, handler } = yield* resolve(row);
      // Every attempt searches by `external_id` before it writes and works on the oldest check run it finds
      // (FD-GH-010). `row.attempts` holds the value from insertion, so it does not mark a repeat.
      const run = (yield* matching)[0] ?? null;
      return yield* call(
        ctx.installation,
        handler.apply(ctx, payload, run).pipe(Effect.provideService(AlarmPort, alarms)),
      );
    }).pipe(
      Effect.catchTags({
        Unservable: ({ reason }) => Effect.succeed<ApplyAnswer>({ _tag: "refused", reason }),
        ConcludeFactsUnavailable: ({ message }) =>
          Effect.succeed<ApplyAnswer>({ _tag: "retryable", reason: `records: ${message}` }),
        GithubHttpError: (e) =>
          e.status === 401
            ? Effect.as(raiseInstallationLost(row, "installation: unauthorized"), classify(e))
            : Effect.succeed(classify(e)),
        GithubNetworkError: (e) => Effect.succeed(classify(e)),
      }),
    );

  /**
   * The check run carrying the row's effect, or null when the effect is not on GitHub. A read that fails, cannot
   * reach GitHub, or finds the execution's check run more than once, proves neither.
   */
  const adoptedRun = (row: IntentRow): Effect.Effect<CheckRun | null, ReadFailure> =>
    Effect.gen(function* () {
      const { ctx, matching, payload, handler } = yield* resolve(row);
      const runs = yield* matching;
      if (runs.length > 1) return yield* Effect.fail(new AmbiguousCheckRun({ count: runs.length }));
      const run = runs[0];
      if (run === undefined) return null;
      return (yield* call(ctx.installation, handler.adopted(ctx, payload, run))) ? run : null;
    });

  // Neither read guesses: `absent` sends an adoptable row again and voids a reconcile-only one, so a read without
  // an answer is `undetermined`, the row stays ambiguous and the drainer asks again after back-off
  // (MAMEKO-OUT-025, MAMEKO-OUT-064).
  const undetermined = (e: ReadFailure) =>
    Match.value(e).pipe(
      Match.tag("AmbiguousCheckRun", ({ count }) => `check run: ${count} carry the execution id`),
      Match.tag("Unservable", ({ reason }) => reason),
      Match.tag("ConcludeFactsUnavailable", ({ message }) => `records: ${message}`),
      Match.orElse(reasonOf),
    );

  const service: Required<Actuator> = {
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
  return service;
});

/** The check-run applier registered as the actuator of the profile's `checkRun` binding. */
export const CheckRunApplierLive = Layer.effect(
  Actuators,
  Effect.map(makeCheckRunApplier, (checkRun) => actuatorRegistry({ checkRun })),
);
