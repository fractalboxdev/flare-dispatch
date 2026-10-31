// The control plane's HTTP routes: enrollment, dispatch and the execution record. Every error answers the JSON shape of
// specs/interfaces.md § Error model.
import { classNamed, deviceSlotDefaults } from "@fractalboxdev/flare-dispatch-profile";
import { CheckInput, lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import {
  dedupKey,
  executionId,
  registerDevice,
  type DedupRecipe,
} from "@fractalboxdev/mameko-coordinator";
import { admitExecution, wakeStandingClaims } from "@fractalboxdev/mameko-host-cloudflare";
import { cloudflareRuntimeLayer } from "@fractalboxdev/mameko-host-cloudflare/runtime";
import { Effect, Match, Schema } from "effect";
import { deployment, profileOf, type ControlPlaneEnv } from "./config.ts";
import { dropExecutionInputs, putExecutionInputs } from "./inputs.ts";

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

const json = (body: unknown, status = 200) => Response.json(body, { status });

const constantTimeEquals = async (a: string, b: string) => {
  const digest = (text: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then((d) => new Uint8Array(d));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x.reduce((different, byte, i) => different | (byte ^ y[i]!), 0) === 0;
};

/** The operator's identity: a bearer token from the deployment's environment, with no mode that skips it. */
export const requireOperator = (request: Request, env: ControlPlaneEnv) =>
  Effect.gen(function* () {
    const expected = env.OPERATOR_TOKEN;
    if (expected === undefined || expected === "")
      return yield* new ApiError({
        status: 503,
        code: "not_configured",
        message: "this deployment has no operator identity",
      });
    const header = request.headers.get("authorization");
    if (header === null)
      return yield* new ApiError({
        status: 401,
        code: "unauthenticated",
        message: "an operator bearer token is required",
      });
    const accepted = yield* Effect.promise(() => constantTimeEquals(header, `Bearer ${expected}`));
    if (!accepted)
      return yield* new ApiError({
        status: 403,
        code: "forbidden",
        message: "the bearer token is not an operator's",
      });
  });

const readJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () =>
      new ApiError({ status: 400, code: "invalid_body", message: "the body is not JSON" }),
  });

const decodeOr =
  <S extends Schema.Decoder<unknown>>(schema: S, code: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((e) => new ApiError({ status: 400, code, message: e.message })),
    );

const RegisterBody = Schema.Struct({
  executor_id: Schema.NonEmptyString,
  labels: Schema.Array(Schema.String),
  protocol_version: Schema.String,
  code_hash: Schema.NullOr(Schema.String),
  identity: Schema.Struct({
    public_key: Schema.String,
    key_store: Schema.Literals(["secure-enclave", "tpm", "software"]),
    certificate_chain: Schema.Array(Schema.String),
    evidence: Schema.Unknown,
  }),
});

/** The tier of a single operator's own workstation; a software key attests nothing above it. */
const POSTURE_TIER = "unmanaged";

/**
 * `POST /v1/executors/register` (FD-IFC-086, FD-IFC-087). The slots are the device defaults of the profile. No
 * attestation verifier is wired, so a profile that requires one refuses every key.
 */
export const register = (request: Request, env: ControlPlaneEnv) =>
  Effect.gen(function* () {
    const body = yield* readJson(request).pipe(
      Effect.flatMap(decodeOr(RegisterBody, "invalid_body")),
    );
    const { interactive, batch } = deviceSlotDefaults.claim_caps;
    const { registration } = profileOf(env);
    const result = yield* registerDevice(
      {
        executorId: body.executor_id,
        identity: {
          publicKey: body.identity.public_key,
          keyStore: body.identity.key_store,
          certificateChain: body.identity.certificate_chain,
          evidence: body.identity.evidence,
        },
        labels: body.labels,
        slots: { interactive, batch },
        protocolVersion: body.protocol_version,
        codeHash: body.code_hash,
      },
      {
        registration,
        now: Date.now(),
        posture: () => Effect.succeed(POSTURE_TIER),
        verify: () => Effect.succeed(false),
      },
    ).pipe(
      Effect.provide(
        cloudflareRuntimeLayer({
          db: env.DB,
          anchor: env.EPOCH_ANCHOR.get(env.EPOCH_ANCHOR.idFromName("control-plane")),
        }),
      ),
    );
    return yield* Match.value(result).pipe(
      Match.tag("Registered", ({ executorId, postureTier }) =>
        Effect.succeed(json({ executor_id: executorId, posture_tier: postureTier }, 201)),
      ),
      Match.tag("Refused", ({ reason }) =>
        Effect.fail(
          new ApiError({
            status: 403,
            code: "registration_refused",
            message: `registration refused: ${reason}`,
          }),
        ),
      ),
      Match.exhaustive,
    );
  });

const DispatchBody = Schema.Struct({
  /** `<owner>/<name>`, the execution's scope. */
  repository: Schema.NonEmptyString,
  inputs: CheckInput,
});
type DispatchBody = typeof DispatchBody.Type;

/** A class's `bounds` in the profile, a value mameko's profile schema leaves undecoded. */
const ClassBounds = Schema.Struct({
  global: Schema.Number,
  per_scope: Schema.optionalKey(Schema.Number),
  per_run_scope: Schema.optionalKey(Schema.Number),
});

const admissionBounds = (bounds: unknown) => {
  const decoded = Schema.decodeUnknownSync(ClassBounds)(bounds);
  return {
    global: decoded.global,
    perScope: decoded.per_scope ?? decoded.per_run_scope ?? decoded.global,
  };
};

/** A commit-scoped key, so one commit runs once (FD-INT-009). */
const dedupRecipes = (run: string): readonly DedupRecipe<DispatchBody>[] => [
  { name: "commit", run: (r) => `${run}:${r.repository}:${r.inputs.sha}` },
];

/** `POST /v1/dispatch/:run`. A run the deployment refuses answers `forbidden` before the body is read. */
export const dispatch = (run: string, request: Request, env: ControlPlaneEnv) =>
  Effect.gen(function* () {
    const profile = profileOf(env);
    const entry = yield* Match.value(lookupRun(deployment(env), run)).pipe(
      Match.tag("Available", ({ entry }) => Effect.succeed(entry)),
      Match.tag("HostExecutionRefused", () =>
        Effect.fail(
          new ApiError({
            status: 403,
            code: "forbidden",
            message: `run ${run} executes on the device host, which MAMEKO-ISO-001 forbids; this deployment refuses it`,
          }),
        ),
      ),
      Match.tag("NotInCatalogue", () =>
        Effect.fail(
          new ApiError({ status: 404, code: "run_not_found", message: `no run named ${run}` }),
        ),
      ),
      Match.exhaustive,
    );
    const body = yield* readJson(request).pipe(
      Effect.flatMap(decodeOr(DispatchBody, "invalid_inputs")),
    );
    const className = entry.spec.limits.qosClass;
    const bounds = admissionBounds(classNamed(profile, className)?.bounds);
    const now = Date.now();
    const id = executionId(now, Math.random);
    const key = yield* Effect.promise(() => dedupKey(dedupRecipes(run), body));
    // The row goes in first, so a device that claims the moment admission commits finds the inputs.
    yield* putExecutionInputs(env.DB, id, {
      inputs: body.inputs,
      deadlineAtMs: now + entry.spec.limits.maxDurationSec * 1000,
    });
    const admitted = yield* admitExecution(env.DB, {
      executionId: id,
      scopeId: body.repository,
      run,
      className,
      enqueuedAtMs: now,
      dedup: {
        sha256: key.sha256,
        canonical: key.canonical,
        requestDigest: null,
        onMismatch: "duplicate",
      },
      bounds,
    }).pipe(
      Effect.mapError(
        () =>
          new ApiError({
            status: 503,
            code: "intake_unavailable",
            message: "admission failed; nothing was written",
          }),
      ),
    );
    return yield* Match.value(admitted).pipe(
      Match.tag("Queued", ({ executionId: queued }) =>
        Effect.promise(async () => {
          await wakeStandingClaims(env.DB, env.CHANNEL, {
            className,
            eligibleKinds: ["device"],
          });
          return json({ execution_id: queued, class: className }, 202);
        }),
      ),
      Match.tag("Duplicate", "Conflict", ({ executionId: existing }) =>
        dropExecutionInputs(env.DB, id).pipe(
          Effect.as(json({ execution_id: existing, class: className, duplicate: true }, 202)),
        ),
      ),
      Match.tag("Concluded", ({ reason }) =>
        Effect.fail(new ApiError({ status: 429, code: "rate_limited", message: reason })),
      ),
      Match.exhaustive,
    );
  });

interface ExecutionRow {
  readonly id: string;
  readonly run: string;
  readonly class: string;
  readonly status: string;
  readonly reason: string | null;
  readonly epoch: number | null;
  readonly accepted_epoch: number | null;
  readonly executor_id: string | null;
  readonly outcome_rows: number;
}

const readExecution = (env: ControlPlaneEnv, id: string) =>
  Effect.promise(async () => {
    const { results } = await env.DB.prepare(
      `select e.id, e.run, e.class, e.status, e.reason, p.epoch, p.accepted_epoch, p.executor_id,
         (select count(*) from outbox o where o.execution_id = e.id and o.intent_key = 'outcome') as outcome_rows
       from executions e left join placements p on p.execution_id = e.id where e.id = ?`,
    )
      .bind(id)
      .all();
    return results[0] as ExecutionRow | undefined;
  });

const reportedStatus = (status: string) =>
  Match.value(status).pipe(
    Match.when("pending", () => "queued"),
    Match.when("running", () => "running"),
    Match.orElse(() => "done"),
  );

/** The execution as the coordinator recorded it: `verdict` is the `executions` row the `apply-outbox` stage writes. */
const executionView = (row: ExecutionRow) => {
  const status = reportedStatus(row.status);
  return {
    execution_id: row.id,
    run: row.run,
    class: row.class,
    status,
    verdict: status === "done" ? row.status : null,
    reason: row.reason,
    epoch: row.epoch,
    accepted_epoch: row.accepted_epoch,
    executor_id: row.executor_id,
    outcome_intents: row.outcome_rows,
  };
};

const WAIT_POLL_MS = 500;

const parseWait = (raw: string | null) =>
  Effect.gen(function* () {
    if (raw === null) return 0;
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
      return yield* new ApiError({
        status: 400,
        code: "invalid_wait",
        message: "wait is a whole number from 1 to 60",
      });
    return seconds;
  });

/** `GET /v1/executions/:id`; `?wait=<s>` holds the response until the execution is `done` or the wait ends. */
export const getExecution = (id: string, url: URL, env: ControlPlaneEnv) =>
  Effect.gen(function* () {
    const waitSeconds = yield* parseWait(url.searchParams.get("wait"));
    const until = Date.now() + waitSeconds * 1000;
    while (true) {
      const row = yield* readExecution(env, id);
      if (row === undefined)
        return yield* new ApiError({
          status: 404,
          code: "execution_not_found",
          message: `no execution ${id}`,
        });
      if (reportedStatus(row.status) === "done" || Date.now() >= until)
        return json(executionView(row));
      yield* Effect.sleep(WAIT_POLL_MS);
    }
  });
