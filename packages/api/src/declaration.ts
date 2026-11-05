// The one `effect/http-api` declaration of FlareDispatch's HTTP API (FD-IFC-001). The dispatcher serves it, and `fd`,
// the dispatch action and the MCP tools derive their clients and tool schemas from it (FD-IFC-002, FD-IFC-077). This
// module imports no server code, so a client bundle carries only schemas.
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { ApiErrors } from "./errors.ts";
import { ErrorModel } from "./request-id.ts";

// --- signals/v1 and incident/v1 --------------------------------------------------------------------------------------

const capped = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** One `signals/v1` entry, with the caps of FD-IFC-030. */
export const Signal = Schema.Struct({
  source: capped(120),
  title: capped(200),
  detail: capped(2000),
  url: Schema.optionalKey(capped(1000)),
  count: Schema.optionalKey(Schema.Number),
});
export const SignalsV1 = Schema.Array(Signal).check(Schema.isMaxLength(50));
export type SignalsV1 = typeof SignalsV1.Type;

/** The caps of an `incident/v1` pack (FD-IFC-042). */
export const INCIDENT_CAPS = {
  logTail: 4000,
  text: 2000,
  path: 400,
  serializedBytes: 16_384,
} as const;

export const IncidentV1 = Schema.Struct({
  contractVersion: Schema.Literal("v1"),
  incidentId: Schema.String,
  class: Schema.Literals(["ci", "application", "demo"]),
  repo: Schema.String,
  suspectRef: Schema.optionalKey(
    Schema.Struct({
      base: Schema.String,
      head: Schema.String,
      confidence: Schema.optionalKey(Schema.Number),
      advisory: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  diagnosis: Schema.optionalKey(
    Schema.Struct({
      title: Schema.String,
      area: Schema.String,
      diagnosis: Schema.String,
      suggestedFix: Schema.String,
    }),
  ),
  signals: Schema.optionalKey(Schema.Array(Signal)),
  ciFailures: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["actions", "pages", "run-step"]),
        name: Schema.String,
        conclusion: Schema.String,
        command: Schema.optionalKey(Schema.String),
        logTail: Schema.optionalKey(Schema.String),
        url: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  suspectFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  repro: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(["command", "derived", "none"]),
      command: Schema.optionalKey(Schema.String),
      note: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type IncidentV1 = typeof IncidentV1.Type;

// --- Executions ------------------------------------------------------------------------------------------------------

/** The status the API reports (specs/interfaces.md § Execution status as the API reports it). */
export const ReportedStatus = Schema.Literals(["queued", "running", "done"]);
export type ReportedStatus = typeof ReportedStatus.Type;

export const VerdictName = Schema.Literals(["success", "failure", "cancelled", "skipped"]);
export type VerdictName = typeof VerdictName.Type;

/**
 * One execution as every executions route returns it (FD-IFC-038). It carries no input payload and no secret value
 * (FD-IFC-039).
 */
export const ExecutionView = Schema.Struct({
  execution_id: Schema.String,
  run: Schema.String,
  repository: Schema.String,
  class: Schema.String,
  status: ReportedStatus,
  /** `null` until `done`, and for an execution that ended `deferred` or `expired`. */
  verdict: Schema.NullOr(VerdictName),
  reason: Schema.NullOr(Schema.String),
  /** The check-run conclusion the verdict maps to (specs/github-output.md § Conclusion mapping). */
  conclusion: Schema.NullOr(Schema.Literals(["success", "failure", "cancelled", "neutral"])),
  /** True for a verdict of capacity-lease work, which gates nothing (FD-IFC-081). */
  advisory: Schema.Boolean,
  placement: Schema.NullOr(Schema.String),
  executor_id: Schema.NullOr(Schema.String),
  executor_kind: Schema.NullOr(Schema.String),
  epoch: Schema.NullOr(Schema.Number),
  accepted_epoch: Schema.NullOr(Schema.Number),
  reserved_micro_usd: Schema.NullOr(Schema.Number),
  settled_micro_usd: Schema.NullOr(Schema.Number),
  enqueued_at: Schema.Number,
});
export type ExecutionView = typeof ExecutionView.Type;

const Limit = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 200 }),
);

export const ExecutionsPage = Schema.Struct({
  executions: Schema.Array(ExecutionView),
  /** The cursor of the next page; absent on the last page. */
  next_before: Schema.optionalKey(Schema.String),
});

// --- Dispatch --------------------------------------------------------------------------------------------------------

export const DispatchBody = Schema.Struct({
  /** `<owner>/<repo>`, the execution's tenant scope. */
  repository: Schema.NonEmptyString,
  ref: Schema.optionalKey(Schema.String),
  sha: Schema.optionalKey(Schema.String),
  /** Decoded by the run's input schema at intake (FD-IFC-029). */
  inputs: Schema.Unknown,
  /** Passed to `resolveClass` as its `class` input (FD-IFC-033). */
  class: Schema.optionalKey(Schema.String),
  signals: Schema.optionalKey(SignalsV1),
});
export type DispatchBody = typeof DispatchBody.Type;

export const Dispatched = Schema.Struct({
  execution_id: Schema.String,
  class: Schema.String,
  details_url: Schema.String,
  logs_url: Schema.String,
  duplicate: Schema.optionalKey(Schema.Literal(true)),
});
export type Dispatched = typeof Dispatched.Type;

// --- Operator operations ---------------------------------------------------------------------------------------------

/** Every operator operation carries a reason; the coordinator rejects one outside 1 to 500 characters (FD-IFC-047). */
const Reason = { reason: Schema.String };

export const OperationResult = Schema.Struct({
  operation: Schema.String,
  target: Schema.String,
  request_id: Schema.String,
  at: Schema.Number,
});

export const HaltBody = Schema.Struct({
  state: Schema.Literals(["run", "halt-cloud", "halt-all"]),
  ...Reason,
});
export const ExecutorOrRepository = Schema.Union([
  Schema.Struct({ executor: Schema.NonEmptyString, ...Reason }),
  Schema.Struct({ repository: Schema.NonEmptyString, ...Reason }),
]);
export const ExecutorTarget = Schema.Struct({ executor: Schema.NonEmptyString, ...Reason });
export const ForceAdmitBody = Schema.Struct({
  execution_id: Schema.NonEmptyString,
  /** Unix milliseconds, at most 7 days ahead (FD-IFC-050). */
  expires_at: Schema.Number,
  ...Reason,
});
export const TopUpBody = Schema.Struct({
  amount_micro_usd: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  expires_at: Schema.Number,
  ...Reason,
});
export const DeliveryKeyBody = Schema.Struct({ installation: Schema.NonEmptyString, ...Reason });

// --- Enrollment ------------------------------------------------------------------------------------------------------

export const DeviceIdentity = Schema.Struct({
  public_key: Schema.String,
  key_store: Schema.Literals(["secure-enclave", "tpm", "software"]),
  certificate_chain: Schema.Array(Schema.String),
  evidence: Schema.Unknown,
});

export const RegisterBody = Schema.Struct({
  executor_id: Schema.NonEmptyString,
  labels: Schema.Array(Schema.String),
  protocol_version: Schema.String,
  code_hash: Schema.NullOr(Schema.String),
  identity: DeviceIdentity,
});
export type RegisterBody = typeof RegisterBody.Type;

export const Registered = Schema.Struct({
  executor_id: Schema.String,
  posture_tier: Schema.String,
});

// --- Well-known ------------------------------------------------------------------------------------------------------

export const PublicJwk = Schema.Struct({
  kty: Schema.String,
  kid: Schema.String,
  alg: Schema.String,
  use: Schema.String,
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
});
export const Jwks = Schema.Struct({ keys: Schema.Array(PublicJwk) });
export const OpenIdConfiguration = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
  response_types_supported: Schema.Array(Schema.String),
  subject_types_supported: Schema.Array(Schema.String),
  id_token_signing_alg_values_supported: Schema.Array(Schema.String),
  claims_supported: Schema.Array(Schema.String),
});

export const Health = Schema.Struct({ status: Schema.Literal("ok") });

// --- Groups ----------------------------------------------------------------------------------------------------------

const errors = { error: ApiErrors };
const IdParam = { params: { id: Schema.String } };

export class DispatchGroup extends HttpApiGroup.make("dispatch")
  .add(
    HttpApiEndpoint.post("dispatch", "/v1/dispatch/:run", {
      params: { run: Schema.String },
      headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
      payload: DispatchBody,
      success: Dispatched.pipe(HttpApiSchema.status(202)),
      ...errors,
    }),
  )
  .middleware(ErrorModel) {}

export class ExecutionsGroup extends HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.get("list", "/v1/executions", {
      query: {
        run: Schema.optionalKey(Schema.String),
        repository: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(ReportedStatus),
        class: Schema.optionalKey(Schema.String),
        executor_kind: Schema.optionalKey(Schema.String),
        before: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Limit),
      },
      success: ExecutionsPage,
      ...errors,
    }),
    HttpApiEndpoint.get("get", "/v1/executions/:id", {
      ...IdParam,
      /** Parsed by the route, so a bad value answers `invalid_wait` (FD-IFC-041). */
      query: { wait: Schema.optionalKey(Schema.String) },
      success: ExecutionView,
      ...errors,
    }),
    HttpApiEndpoint.get("failureSummary", "/v1/executions/:id/failure-summary", {
      ...IdParam,
      success: IncidentV1,
      ...errors,
    }),
    HttpApiEndpoint.post("cancel", "/v1/executions/:id/cancel", {
      ...IdParam,
      success: ExecutionView.pipe(HttpApiSchema.status(202)),
      ...errors,
    }),
  )
  .middleware(ErrorModel) {}

const op = <const Name extends string, P extends Schema.Top>(
  name: Name,
  path: `/v1/ops/${string}`,
  payload: P,
) => HttpApiEndpoint.post(name, path, { payload, success: OperationResult, ...errors });

export class OpsGroup extends HttpApiGroup.make("ops")
  .add(
    op("halt", "/v1/ops/halt", HaltBody),
    op("quarantine", "/v1/ops/quarantine", ExecutorOrRepository),
    op("release", "/v1/ops/release", ExecutorOrRepository),
    op("forceAdmit", "/v1/ops/force-admit", ForceAdmitBody),
    op("topUp", "/v1/ops/top-up", TopUpBody),
    op("drain", "/v1/ops/drain", ExecutorTarget),
    op("revoke", "/v1/ops/revoke", ExecutorTarget),
    op("pauseKey", "/v1/ops/pause-key", DeliveryKeyBody),
    op("resumeKey", "/v1/ops/resume-key", DeliveryKeyBody),
    HttpApiEndpoint.get("health", "/v1/ops/health", {
      success: Schema.Record(Schema.String, Schema.Unknown),
      ...errors,
    }),
  )
  .middleware(ErrorModel) {}

export class ExecutorsGroup extends HttpApiGroup.make("executors")
  .add(
    HttpApiEndpoint.post("register", "/v1/executors/register", {
      payload: RegisterBody,
      success: Registered.pipe(HttpApiSchema.status(201)),
      ...errors,
    }),
  )
  .middleware(ErrorModel) {}

export class WellKnownGroup extends HttpApiGroup.make("wellKnown")
  .add(
    HttpApiEndpoint.get("openidConfiguration", "/.well-known/openid-configuration", {
      success: OpenIdConfiguration,
      ...errors,
    }),
    HttpApiEndpoint.get("jwks", "/.well-known/jwks.json", { success: Jwks, ...errors }),
    HttpApiEndpoint.get("health", "/health", { success: Health }),
  )
  .middleware(ErrorModel) {}

/** A log as the route serves it: NDJSON, or plain text with `?format=text` (FD-CACHE-083). */
const LogText = Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/x-ndjson" }));
const LogQuery = { format: Schema.optionalKey(Schema.Literal("text")) };

/**
 * The redacted step logs. The cache-artifacts area implements these handlers; the declaration holds their schemas so
 * `fd logs` derives its client from it (FD-IFC-002).
 */
export class LogsGroup extends HttpApiGroup.make("logs")
  .add(
    HttpApiEndpoint.get("aggregate", "/v1/executions/:id/logs", {
      ...IdParam,
      query: LogQuery,
      success: LogText,
      ...errors,
    }),
    HttpApiEndpoint.get("file", "/v1/executions/:id/logs/:file", {
      params: { id: Schema.String, file: Schema.String },
      query: LogQuery,
      success: LogText,
      ...errors,
    }),
  )
  .middleware(ErrorModel) {}

/** The declaration. Every route the dispatcher serves through the router is an endpoint of one of these groups. */
export class FlareDispatchApi extends HttpApi.make("flare-dispatch")
  .add(DispatchGroup)
  .add(ExecutionsGroup)
  .add(OpsGroup)
  .add(ExecutorsGroup)
  .add(WellKnownGroup)
  .add(LogsGroup) {}
