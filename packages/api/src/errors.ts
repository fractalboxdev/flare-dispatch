// The error model of specs/interfaces.md § Error model: a closed set of codes, one `Schema.TaggedError` class per HTTP
// status, and the wire shape `{ error, message, request_id }` every error response carries.
import { Schema, SchemaGetter } from "effect";
import { HttpApiSchema } from "effect/http-api";

/** Each status of the error-model table and the codes it carries. */
export const CODES = {
  400: [
    "invalid_body",
    "invalid_inputs",
    "invalid_signals",
    "invalid_idempotency_key",
    "invalid_wait",
    "reason_required",
    "model_request_invalid",
  ],
  401: ["unauthenticated", "lease_stale", "proof_invalid"],
  402: ["allowance_exhausted"],
  403: [
    "forbidden",
    "repository_mismatch",
    "link_expired",
    "link_revoked",
    "model_route_refused",
    "registration_refused",
  ],
  404: ["not_found", "run_not_found", "execution_not_found"],
  405: ["method_not_allowed"],
  409: ["conflict", "not_failed", "not_finished"],
  413: ["payload_too_large"],
  422: ["installation_not_found"],
  429: ["rate_limited"],
  500: ["internal"],
  503: [
    "not_configured",
    "unavailable",
    "misconfigured",
    "intake_unavailable",
    "webhook_unconfigured",
    "spend_unreadable",
  ],
  507: ["storage_bound"],
} as const;

type Codes = typeof CODES;
export type Status = keyof Codes;
export type ErrorCode = Codes[Status][number];

/** The status the table assigns to a code. */
export const statusOf = (code: ErrorCode): Status =>
  Number(
    Object.entries(CODES).find(([, codes]) => (codes as readonly string[]).includes(code))![0],
  ) as Status;

const fields = <const C extends readonly [string, ...string[]]>(codes: C) => ({
  error: Schema.Literals(codes),
  message: Schema.String,
  /** Assigned by the router; a handler leaves it out. */
  request_id: Schema.optionalKey(Schema.String),
});

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  fields(CODES[400]),
) {}
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  fields(CODES[401]),
) {}
export class AllowanceExhausted extends Schema.TaggedError<AllowanceExhausted>()(
  "AllowanceExhausted",
  fields(CODES[402]),
) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", fields(CODES[403])) {}
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", fields(CODES[404])) {}
export class MethodNotAllowed extends Schema.TaggedError<MethodNotAllowed>()(
  "MethodNotAllowed",
  fields(CODES[405]),
) {}
/** `conflict` carries the execution an `Idempotency-Key` already names (FD-IFC-036). */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  ...fields(CODES[409]),
  execution_id: Schema.optionalKey(Schema.String),
}) {}
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  "PayloadTooLarge",
  fields(CODES[413]),
) {}
export class InstallationNotFound extends Schema.TaggedError<InstallationNotFound>()(
  "InstallationNotFound",
  fields(CODES[422]),
) {}
/** `retry_after` is seconds; the router writes it as the `Retry-After` header, not into the body. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  ...fields(CODES[429]),
  retry_after: Schema.optionalKey(Schema.Number),
}) {}
export class Internal extends Schema.TaggedError<Internal>()("Internal", fields(CODES[500])) {}
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  fields(CODES[503]),
) {}
export class StorageBound extends Schema.TaggedError<StorageBound>()(
  "StorageBound",
  fields(CODES[507]),
) {}

export type ApiError =
  | InvalidRequest
  | Unauthenticated
  | AllowanceExhausted
  | Forbidden
  | NotFound
  | MethodNotAllowed
  | Conflict
  | PayloadTooLarge
  | InstallationNotFound
  | RateLimited
  | Internal
  | Unavailable
  | StorageBound;

const CLASSES = {
  400: InvalidRequest,
  401: Unauthenticated,
  402: AllowanceExhausted,
  403: Forbidden,
  404: NotFound,
  405: MethodNotAllowed,
  409: Conflict,
  413: PayloadTooLarge,
  422: InstallationNotFound,
  429: RateLimited,
  500: Internal,
  503: Unavailable,
  507: StorageBound,
} as const;

const API_ERROR_TAGS: ReadonlySet<string> = new Set(Object.values(CLASSES).map((c) => c.name));

export const isApiError = (u: unknown): u is ApiError =>
  typeof u === "object" && u !== null && API_ERROR_TAGS.has((u as { _tag?: string })._tag ?? "");

/** Builds the error a code names, so a handler writes `apiError("run_not_found", "...")`. */
export const apiError = (
  code: ErrorCode,
  message: string,
  extra: { readonly execution_id?: string; readonly retry_after?: number } = {},
): ApiError => {
  const status = statusOf(code);
  const Class = CLASSES[status] as unknown as new (props: object) => ApiError;
  return new Class({ error: code, message, ...extra });
};

export const statusOfError = (error: ApiError): Status => statusOf(error.error);

/** The JSON body of an error response (FD-IFC-009); `retry_after` travels as a header. */
export const errorBody = (error: ApiError, requestId: string) => {
  const body: Record<string, unknown> = {
    error: error.error,
    message: error.message,
    request_id: requestId,
  };
  if ("execution_id" in error && error.execution_id !== undefined)
    body["execution_id"] = error.execution_id;
  return body;
};

/**
 * The wire form of an error class: the class without its `_tag`, at its status, so the generated clients decode the
 * same `{ error, message, request_id }` object the router writes.
 */
const onWire = <C extends Schema.Top & { readonly fields: Schema.Struct.Fields }>(
  cls: C,
  status: number,
): Schema.decodeTo<C, Schema.Struct<Omit<C["fields"], "_tag">>> => {
  const { _tag: tag, ...wireFields } = cls.fields;
  const tagValue = (tag as unknown as { readonly ast: { readonly literal: string } }).ast.literal;
  const decodeTo = Schema.decodeTo as unknown as (
    to: Schema.Top,
    transformation: object,
  ) => (from: Schema.Top) => Schema.Top;
  return Schema.Struct(wireFields)
    .pipe(
      decodeTo(cls, {
        decode: SchemaGetter.transform((wire: object) => ({ ...wire, _tag: tagValue })),
        encode: SchemaGetter.transform(({ _tag, ...wire }: { readonly _tag: string }) => wire),
      }),
    )
    .pipe(HttpApiSchema.status(status)) as unknown as Schema.decodeTo<
    C,
    Schema.Struct<Omit<C["fields"], "_tag">>
  >;
};

/** The error schemas an endpoint declares: every status, on the wire. */
export const ApiErrors = [
  onWire(InvalidRequest, 400),
  onWire(Unauthenticated, 401),
  onWire(AllowanceExhausted, 402),
  onWire(Forbidden, 403),
  onWire(NotFound, 404),
  onWire(MethodNotAllowed, 405),
  onWire(Conflict, 409),
  onWire(PayloadTooLarge, 413),
  onWire(InstallationNotFound, 422),
  onWire(RateLimited, 429),
  onWire(Internal, 500),
  onWire(Unavailable, 503),
  onWire(StorageBound, 507),
] as const;
